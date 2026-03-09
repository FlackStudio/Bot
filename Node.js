// npm i discord.js express dotenv
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActivityType,
} = require("discord.js");

const app = express();
app.use(express.json());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

const API_TOKEN = process.env.API_TOKEN;
const GAME_ID = process.env.GAME_ID || "main";
const ROLE_PERMISSIONS_RAW = process.env.ROLE_PERMISSIONS || "";
const DATA_FILE = path.join(__dirname, "moderation-data.json");

const COLORS = {
  ban: 0xed4245, // red
  unban: 0x57f287, // green
  kick: 0xfee75c, // yellow
  warn: 0xf4900c, // orange
  note: 0x3498db, // blue
  moderation: 0x3498db, // blue
};

// In-memory command delivery for Roblox polling
const commandStreamsByGame = new Map(); // gameId -> [{ id, type, data, at }]
const commandCursorByServer = new Map(); // `${gameId}:${serverId}` -> lastSeenCommandId
let nextCommandId = 1;
const onlinePlayersByGame = new Map(); // gameId -> Map(serverId -> { players: Set<string>, updatedAt: number })
const PRESENCE_TTL_MS = 30 * 1000;
const COMMAND_TTL_MS = 2 * 60 * 1000;
const COMMAND_PERMISSION = {
  ban: "Ban",
  unban: "Ban",
  kick: "Kick",
  warn: "Warn",
  note: "Notes",
  info: "Info",
  clearlogs: "ClearLogs",
};

function parseRolePermissions(raw) {
  const map = new Map();
  const entries = String(raw)
    .replace(/\r/g, "")
    .split(/[\n;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const noComment = entry.replace(/\s*(#|--).*$/, "").trim();
    if (!noComment) continue;
    const cleaned = noComment.replace(/,+\s*$/, "");
    const eq = cleaned.indexOf("=");
    if (eq <= 0) continue;
    const leftSide = cleaned.slice(0, eq).trim();
    const idMatch = leftSide.match(/\d{17,20}/);
    const roleId = idMatch ? idMatch[0] : leftSide;
    const tokens = cleaned
      .slice(eq + 1)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!roleId || !tokens.length) continue;

    const permissions = new Set();
    let permBan = false;

    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (lower === "perm=true") {
        permBan = true;
        continue;
      }
      if (lower === "perm=false") {
        permBan = false;
        continue;
      }
      permissions.add(lower);
    }

    map.set(roleId, { permissions, permBan });
  }
  return map;
}

const rolePermissions = parseRolePermissions(ROLE_PERMISSIONS_RAW);

function pushCommand(gameId, cmd) {
  const key = String(gameId);
  if (!commandStreamsByGame.has(key)) commandStreamsByGame.set(key, []);
  const stream = commandStreamsByGame.get(key);
  stream.push({ id: nextCommandId++, ...cmd, at: Date.now() });
  pruneOldCommands(key);
}

function updateOnlinePlayers(gameId, serverId, players) {
  const key = String(gameId);
  const sid = String(serverId || "default");
  if (!onlinePlayersByGame.has(key)) onlinePlayersByGame.set(key, new Map());
  onlinePlayersByGame.get(key).set(sid, {
    players: new Set(players.map((id) => String(id))),
    updatedAt: Date.now(),
  });
}

function isPlayerOnlineInGame(gameId, userId) {
  const snapshots = onlinePlayersByGame.get(String(gameId));
  if (!snapshots) return false;
  const uid = String(userId);
  const now = Date.now();
  for (const snapshot of snapshots.values()) {
    if (now - snapshot.updatedAt > PRESENCE_TTL_MS) continue;
    if (snapshot.players.has(uid)) return true;
  }
  return false;
}

function pruneOldCommands(gameId) {
  const key = String(gameId);
  const stream = commandStreamsByGame.get(key) || [];
  const cutoff = Date.now() - COMMAND_TTL_MS;
  const kept = stream.filter((c) => c.at >= cutoff);
  commandStreamsByGame.set(key, kept);
}

function getNextCommandForServer(gameId, serverId) {
  const key = String(gameId);
  const sid = String(serverId || "default");
  pruneOldCommands(key);
  const stream = commandStreamsByGame.get(key) || [];
  const cursorKey = `${key}:${sid}`;
  const lastSeen = commandCursorByServer.get(cursorKey) || 0;
  const next = stream.find((c) => c.id > lastSeen) || null;
  if (next) commandCursorByServer.set(cursorKey, next.id);
  return next;
}

function hasCommandPermission(member, commandName) {
  const needed = COMMAND_PERMISSION[commandName];
  if (!needed) return true;
  if (rolePermissions.size === 0) return true;
  if (!member || !member.roles || !member.roles.cache) return false;

  const neededLower = needed.toLowerCase();
  for (const roleId of member.roles.cache.keys()) {
    const access = rolePermissions.get(String(roleId));
    if (access && access.permissions.has(neededLower)) return true;
  }
  return false;
}

function hasPermanentBanPermission(member) {
  if (rolePermissions.size === 0) return true;
  if (!member || !member.roles || !member.roles.cache) return false;

  for (const roleId of member.roles.cache.keys()) {
    const access = rolePermissions.get(String(roleId));
    if (access && access.permBan) return true;
  }
  return false;
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return {
      records: [],
      bans: {},
    };
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      bans: parsed.bans && typeof parsed.bans === "object" ? parsed.bans : {},
    };
  } catch {
    return {
      records: [],
      bans: {},
    };
  }
}

let store = loadData();

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
}

function generateCaseId() {
  let id = "";
  do {
    id = String(Math.floor(10000 + Math.random() * 90000));
  } while (store.records.some((r) => r.caseId === id));
  return id;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString("en-US");
}

function formatReasonBlock(reason) {
  let text = String(reason || "No reason provided");
  text = text.replace(/```/g, "'''");
  if (text.length > 950) text = `${text.slice(0, 947)}...`;
  return `\`\`\`\n${text}\n\`\`\``;
}

function parseDuration(input) {
  if (!input) return { ok: false, error: "Missing length." };
  const text = String(input).trim().toLowerCase();
  if (text === "perm" || text === "permanent") {
    return { ok: true, permanent: true, ms: null, pretty: "PERM" };
  }

  const matches = text.match(/(\d+)\s*([ywdhm])/g);
  if (!matches) {
    return { ok: false, error: "Invalid length. Example: `1d 5h`, `30m`, or `PERM`." };
  }

  let total = 0;
  for (const token of matches) {
    const m = token.match(/(\d+)\s*([ywdhm])/);
    if (!m) continue;
    const value = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(value) || value <= 0) continue;

    if (unit === "y") total += value * 365 * 24 * 60 * 60 * 1000;
    if (unit === "w") total += value * 7 * 24 * 60 * 60 * 1000;
    if (unit === "d") total += value * 24 * 60 * 60 * 1000;
    if (unit === "h") total += value * 60 * 60 * 1000;
    if (unit === "m") total += value * 60 * 1000;
  }

  if (total <= 0) {
    return { ok: false, error: "Invalid length. Example: `1d 5h`, `30m`, or `PERM`." };
  }

  return { ok: true, permanent: false, ms: total, pretty: text.toUpperCase() };
}

async function resolveRobloxUser(target) {
  const trimmed = String(target || "").trim();
  if (!trimmed) throw new Error("Missing target.");

  if (/^\d+$/.test(trimmed)) {
    const res = await fetch(`https://users.roblox.com/v1/users/${trimmed}`);
    if (!res.ok) throw new Error("Roblox user ID not found.");
    const user = await res.json();
    return { userId: String(user.id), username: user.name };
  }

  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      usernames: [trimmed],
      excludeBannedUsers: false,
    }),
  });
  if (!res.ok) throw new Error("Could not resolve Roblox username.");
  const data = await res.json();
  const found = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!found) throw new Error("Roblox username not found.");
  return { userId: String(found.id), username: found.name };
}

async function getHeadshotUrl(userId) {
  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(
        userId
      )}&size=150x150&format=Png&isCircular=false`
    );
    if (!res.ok) return null;
    const body = await res.json();
    const item = body && Array.isArray(body.data) ? body.data[0] : null;
    return item && item.imageUrl ? item.imageUrl : null;
  } catch {
    return null;
  }
}

async function getRobloxUserProfile(userId) {
  try {
    const res = await fetch(`https://users.roblox.com/v1/users/${encodeURIComponent(userId)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function getActiveBan(userId) {
  const entry = store.bans[userId];
  if (!entry) return null;
  if (entry.permanent) return entry;
  if (entry.expiresAt && Date.now() < entry.expiresAt) return entry;
  delete store.bans[userId];
  saveData();
  return null;
}

function buildLogEmbed(action, payload) {
  const embed = new EmbedBuilder()
    .setColor(COLORS[action] || COLORS.moderation)
    .setTimestamp(new Date(payload.timestamp || Date.now()));

  if (payload.thumbnailUrl) embed.setThumbnail(payload.thumbnailUrl);
  if (payload.caseId) embed.setFooter({ text: `Case ID: ${payload.caseId}` });

  if (action === "ban") {
    embed
      .setTitle(`${payload.username} was banned successfully`)
      .addFields(
        { name: "Admin", value: payload.admin, inline: true },
        { name: "Date", value: formatDate(payload.timestamp), inline: true },
        { name: "Length", value: payload.lengthText, inline: true },
        { name: "Reason", value: formatReasonBlock(payload.reason), inline: false },
        { name: "Roblox ID", value: payload.userId, inline: false }
      );
  } else if (action === "unban") {
    embed
      .setTitle(`${payload.username} was unbanned successfully`)
      .addFields(
        { name: "Admin", value: payload.admin, inline: true },
        { name: "Date", value: formatDate(payload.timestamp), inline: true },
        { name: "Reason", value: formatReasonBlock(payload.reason), inline: false },
        { name: "Roblox ID", value: payload.userId, inline: false }
      );
  } else if (action === "kick") {
    embed
      .setTitle(`${payload.username} was kicked successfully`)
      .addFields(
        { name: "Admin", value: payload.admin, inline: true },
        { name: "Date", value: formatDate(payload.timestamp), inline: true },
        { name: "Reason", value: formatReasonBlock(payload.reason), inline: false },
        { name: "Roblox ID", value: payload.userId, inline: false }
      );
  } else if (action === "warn") {
    embed
      .setTitle(`${payload.username} was warned successfully`)
      .addFields(
        { name: "Admin", value: payload.admin, inline: true },
        { name: "Date", value: formatDate(payload.timestamp), inline: true },
        { name: "Reason", value: formatReasonBlock(payload.reason), inline: false },
        { name: "Roblox ID", value: payload.userId, inline: false }
      );
  } else if (action === "note") {
    embed
      .setTitle(`A note was added for ${payload.username} successfully`)
      .addFields(
        { name: "Admin", value: payload.admin, inline: true },
        { name: "Date", value: formatDate(payload.timestamp), inline: true },
        { name: "Reason", value: formatReasonBlock(payload.reason), inline: false },
        { name: "Roblox ID", value: payload.userId, inline: false }
      );
  }

  return embed;
}

function buildSuccessEmbed(action, username) {
  let text = `${username} action completed successfully`;
  if (action === "ban") text = `${username} was banned successfully`;
  if (action === "kick") text = `${username} was kicked successfully`;
  if (action === "warn") text = `${username} was warned successfully`;

  return new EmbedBuilder()
    .setColor(COLORS[action] || COLORS.moderation)
    .setDescription(text)
    .setTimestamp(new Date());
}

async function sendLog(action, payload) {
  const channelId = process.env.LOG_CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    await channel.send({ embeds: [buildLogEmbed(action, payload)] });
  } catch (err) {
    console.error("Failed to send moderation log:", err.message);
  }
}

function makeRecord(action, user, admin, reason, extra = {}) {
  const record = {
    caseId: generateCaseId(),
    action,
    userId: user.userId,
    username: user.username,
    adminDiscordId: admin.id,
    adminDiscordTag: admin.tag,
    reason: reason || "",
    timestamp: Date.now(),
    ...extra,
  };
  store.records.push(record);
  saveData();
  return record;
}

function listCases(userId, action) {
  return store.records.filter((r) => r.userId === userId && r.action === action).slice(-6).reverse();
}

function summarizeCases(records, action) {
  if (!records.length) return "None";
  return records
    .map((r) => {
      const adminRef = r.adminDiscordId ? `<@${r.adminDiscordId}>` : r.adminDiscordTag;
      let line = `#${r.caseId} by ${adminRef}`;
      if (action === "ban" && (r.permanent || r.lengthText)) {
        const len = r.permanent ? "PERM" : r.lengthText;
        line += ` (${len})`;
      }
      if (r.reason) line += ` - ${r.reason}`;
      return line.length > 200 ? `${line.slice(0, 197)}...` : line;
    })
    .join("\n");
}

function moderationSection(label, records, emptyText, action) {
  if (!records.length) return `User has no ${emptyText} on record`;
  return summarizeCases(records, action);
}

app.get("/next-command", (req, res) => {
  const { gameId, token, serverId } = req.query;
  if (token !== API_TOKEN) return res.status(401).json({ error: "bad token" });
  if (!gameId) return res.status(400).json({ error: "missing gameId" });
  if (!serverId) return res.status(400).json({ error: "missing serverId" });

  const cmd = getNextCommandForServer(gameId, serverId);
  return res.json({ command: cmd });
});

app.get("/ban-status", (req, res) => {
  const { token, userId } = req.query;
  if (token !== API_TOKEN) return res.status(401).json({ error: "bad token" });
  if (!userId) return res.status(400).json({ error: "missing userId" });
  const ban = getActiveBan(String(userId));
  if (!ban) return res.json({ banned: false });
  return res.json({
    banned: true,
    reason: ban.reason,
    caseId: ban.caseId,
    adminDiscordTag: ban.adminDiscordTag,
    permanent: !!ban.permanent,
    expiresAt: ban.expiresAt || null,
  });
});

app.post("/presence/update", (req, res) => {
  const { token, gameId, serverId, playerUserIds } = req.body || {};
  if (token !== API_TOKEN) return res.status(401).json({ error: "bad token" });
  if (!gameId) return res.status(400).json({ error: "missing gameId" });
  if (!serverId) return res.status(400).json({ error: "missing serverId" });
  if (!Array.isArray(playerUserIds)) return res.status(400).json({ error: "missing playerUserIds array" });

  updateOnlinePlayers(gameId, serverId, playerUserIds);
  return res.json({ ok: true, online: playerUserIds.length });
});

const commands = [
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a Roblox player")
    .addStringOption((o) => o.setName("target").setDescription("Roblox username or user ID").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Ban reason").setRequired(true))
    .addStringOption((o) => o.setName("length").setDescription("Example: 1d 5h, 30m, PERM").setRequired(true)),
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a Roblox player")
    .addStringOption((o) => o.setName("target").setDescription("Roblox username or user ID").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Unban reason").setRequired(true)),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a Roblox player")
    .addStringOption((o) => o.setName("target").setDescription("Roblox username or user ID").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Kick reason").setRequired(true)),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a Roblox player")
    .addStringOption((o) => o.setName("target").setDescription("Roblox username or user ID").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Warning reason").setRequired(true)),
  new SlashCommandBuilder()
    .setName("note")
    .setDescription("Add a moderation note for a Roblox player")
    .addStringOption((o) => o.setName("target").setDescription("Roblox username or user ID").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Note text").setRequired(true)),
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("View moderation history for a Roblox player")
    .addStringOption((o) => o.setName("target").setDescription("Roblox username or user ID").setRequired(true)),
  new SlashCommandBuilder()
    .setName("clearlogs")
    .setDescription("Clear all moderation logs for a Roblox player")
    .addStringOption((o) => o.setName("target").setDescription("Roblox username").setRequired(true)),
].map((c) => c.toJSON());

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ type: ActivityType.Custom, name: "custom", state: "Moderation Pro Servers" }],
    status: "online",
  });

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  if (process.env.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    // Clear old global commands so duplicates do not appear.
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
    console.log(`Slash commands registered to guild ${process.env.GUILD_ID} and global commands cleared`);
  } else {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("Global slash commands registered");
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;
  const targetRaw = interaction.options.getString("target");
  if (!hasCommandPermission(interaction.member, name)) {
    await interaction.reply({
      content: "You do not have permission to use this command.",
    });
    return;
  }

  try {
    if (name === "info") {
      const user = await resolveRobloxUser(targetRaw);
      const thumb = await getHeadshotUrl(user.userId);
      const profile = await getRobloxUserProfile(user.userId);
      const createdText = profile && profile.created ? formatDate(profile.created) : "Unknown";

      const bans = listCases(user.userId, "ban");
      const kicks = listCases(user.userId, "kick");
      const warns = listCases(user.userId, "warn");
      const notes = listCases(user.userId, "note");

      const embed = new EmbedBuilder()
        .setColor(COLORS.moderation)
        .setTitle("Info")
        .addFields(
          { name: "Username", value: user.username, inline: true },
          { name: "User ID", value: user.userId, inline: true },
          { name: "Account Created", value: createdText, inline: false },
          {
            name: `0 Bans`.replace("0", String(bans.length)),
            value: moderationSection("bans", bans, "bans", "ban"),
            inline: false,
          },
          {
            name: `0 Kicks`.replace("0", String(kicks.length)),
            value: moderationSection("kicks", kicks, "kicks", "kick"),
            inline: false,
          },
          {
            name: `0 Warnings`.replace("0", String(warns.length)),
            value: moderationSection("warnings", warns, "warnings", "warn"),
            inline: false,
          },
          {
            name: `0 Notes`.replace("0", String(notes.length)),
            value: moderationSection("notes", notes, "notes", "note"),
            inline: false,
          }
        )
        .setTimestamp(new Date());

      if (thumb) embed.setThumbnail(thumb);

      await interaction.reply({
        embeds: [embed],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (name === "clearlogs") {
      const user = await resolveRobloxUser(targetRaw);
      store.records = store.records.filter((r) => r.userId !== user.userId);
      delete store.bans[user.userId];
      saveData();
      await interaction.reply({
        content: `Successfully cleared ${user.username}'s logs.`,
      });
      return;
    }

    const user = await resolveRobloxUser(targetRaw);
    const thumb = await getHeadshotUrl(user.userId);
    const reason = interaction.options.getString("reason", true);

    if (name === "ban") {
      const lengthRaw = interaction.options.getString("length", true);
      const parsed = parseDuration(lengthRaw);
      if (!parsed.ok) {
        await interaction.reply({ content: parsed.error });
        return;
      }
      if (parsed.permanent && !hasPermanentBanPermission(interaction.member)) {
        await interaction.reply({
          content: "You do not have permission to issue permanent bans.",
        });
        return;
      }

      const record = makeRecord("ban", user, interaction.user, reason, {
        permanent: parsed.permanent,
        lengthText: parsed.pretty,
        expiresAt: parsed.permanent ? null : Date.now() + parsed.ms,
      });

      store.bans[user.userId] = {
        caseId: record.caseId,
        reason: record.reason,
        permanent: record.permanent,
        expiresAt: record.expiresAt,
        adminDiscordTag: record.adminDiscordTag,
      };
      saveData();

      pushCommand(GAME_ID, {
        type: "ban",
        data: {
          target: user.userId,
          userId: user.userId,
          username: user.username,
          reason,
          adminDiscord: interaction.user.tag,
          caseId: record.caseId,
          permanent: record.permanent,
          expiresAt: record.expiresAt,
        },
      });

      await sendLog("ban", {
        caseId: record.caseId,
        username: user.username,
        userId: user.userId,
        reason,
        admin: interaction.user.tag,
        timestamp: record.timestamp,
        lengthText: record.permanent ? "PERM" : record.lengthText,
        thumbnailUrl: thumb,
      });

      await interaction.reply({
        embeds: [buildSuccessEmbed("ban", user.username)],
      });
      return;
    }

    if (name === "unban") {
      const activeBan = getActiveBan(user.userId);
      if (!activeBan) {
        await interaction.reply({
          content: `${user.username} is not currently banned.`,
        });
        return;
      }

      const record = makeRecord("unban", user, interaction.user, reason);
      delete store.bans[user.userId];
      saveData();

      pushCommand(GAME_ID, {
        type: "unban",
        data: {
          target: user.userId,
          userId: user.userId,
          username: user.username,
          reason,
          adminDiscord: interaction.user.tag,
          caseId: record.caseId,
        },
      });

      await sendLog("unban", {
        caseId: record.caseId,
        username: user.username,
        userId: user.userId,
        reason,
        admin: interaction.user.tag,
        timestamp: record.timestamp,
        thumbnailUrl: thumb,
      });

      await interaction.reply({
        embeds: [
          buildLogEmbed("unban", {
            caseId: record.caseId,
            username: user.username,
            userId: user.userId,
            reason,
            admin: interaction.user.tag,
            timestamp: record.timestamp,
            thumbnailUrl: thumb,
          }),
        ],
      });
      return;
    }

    if (name === "kick") {
      if (!isPlayerOnlineInGame(GAME_ID, user.userId)) {
        await interaction.reply({
          content: "Cannot find user in game.",
        });
        return;
      }

      const record = makeRecord("kick", user, interaction.user, reason);

      pushCommand(GAME_ID, {
        type: "kick",
        data: {
          target: user.userId,
          userId: user.userId,
          username: user.username,
          reason,
          adminDiscord: interaction.user.tag,
          caseId: record.caseId,
        },
      });

      await sendLog("kick", {
        caseId: record.caseId,
        username: user.username,
        userId: user.userId,
        reason,
        admin: interaction.user.tag,
        timestamp: record.timestamp,
        thumbnailUrl: thumb,
      });

      await interaction.reply({
        embeds: [buildSuccessEmbed("kick", user.username)],
      });
      return;
    }

    if (name === "warn") {
      const record = makeRecord("warn", user, interaction.user, reason);

      await sendLog("warn", {
        caseId: record.caseId,
        username: user.username,
        userId: user.userId,
        reason,
        admin: interaction.user.tag,
        timestamp: record.timestamp,
        thumbnailUrl: thumb,
      });

      await interaction.reply({
        embeds: [buildSuccessEmbed("warn", user.username)],
      });
      return;
    }

    if (name === "note") {
      const record = makeRecord("note", user, interaction.user, reason);

      await sendLog("note", {
        caseId: record.caseId,
        username: user.username,
        userId: user.userId,
        reason,
        admin: interaction.user.tag,
        timestamp: record.timestamp,
        thumbnailUrl: thumb,
      });

      await interaction.reply({
        embeds: [
          buildLogEmbed("note", {
            caseId: record.caseId,
            username: user.username,
            userId: user.userId,
            reason,
            admin: interaction.user.tag,
            timestamp: record.timestamp,
            thumbnailUrl: thumb,
          }),
        ],
      });
      return;
    }
  } catch (err) {
    await interaction.reply({
      content: `Error: ${err.message || "Something went wrong."}`,
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("API listening");
});

client.login(process.env.DISCORD_TOKEN);

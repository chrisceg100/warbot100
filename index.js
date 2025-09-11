// WarBot100 test: confirming GitHub push + commit log

// index.js — WarBot PRODUCTION (sticky wizard + War ID always visible + Render-friendly)

// ---------- Crash guards ----------
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err?.stack || err));
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err?.stack || err));
process.on('warning', (w) => console.warn('NODE WARNING:', w?.stack || w));

import 'dotenv/config';
import http from 'http';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,rm -f 0
git apply --check warbot.patch

  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from 'discord.js';
import { google } from 'googleapis';

import {
  initSheets,
  getNextWarId,
  pushWarLock,
  pushAddedMap,
} from './sheets.js';
import { initDB, getPlayerStats } from './db.js';

// ---------- Tiny HTTP server (only if PORT exists; OK for Render Web Service) ----------
const portFromEnv = Number(process.env.PORT);
if (Number.isFinite(portFromEnv) && portFromEnv > 0) {
  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WarBot OK\n');
  });
  server.on('error', (e) => console.error('Health server error:', e));
  server.listen(portFromEnv, '0.0.0.0', () => console.log(`🌐 Health server listening on :${portFromEnv}`));
} else {
  console.log('ℹ️ No PORT provided; skipping HTTP health server (OK for Background Worker).');
}

// ---------- Config ----------
const AUTO_THREAD = String(process.env.AUTO_THREAD ?? 'true').toLowerCase() === 'true';
const ARCHIVE_MINUTES = Number(process.env.ARCHIVE_MINUTES || 1440); // 1 day
const CLEANUP_MS = (Number(process.env.CLEANUP_SECONDS || 10)) * 1000;

function isAdminish(member) {
  if (!member) return false;
  const roleIds = [
    process.env.ROLE_ADMIN,
    process.env.ROLE_MANAGER,
    process.env.ROLE_KEEPER,
    process.env.ROLE_CAPTAIN,
  ].filter(Boolean);
  if (roleIds.some((id) => member.roles.cache.has(id))) return true;
  return (
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.ManageMessages)
  );
}

// ---------- Always keep War ID visible ----------
function embedWithWarId(baseEmbed, warId) {
  const idTxt = String(warId);
  const title = baseEmbed.title && !/War Sign-up #/i.test(baseEmbed.title)
    ? baseEmbed.title
    : `War Sign-up #${idTxt}`;

  const desc = baseEmbed.description || '';
  const ensuredDesc = /\*\*War ID:\*\s*.*/i.test(desc)
    ? desc.replace(/\*\*War ID:\*\s*.*/i, `**War ID:** ${idTxt}`)
    : `**War ID:** ${idTxt}\n${desc}`;

  return { ...baseEmbed, title, description: ensuredDesc, footer: { text: `War #${idTxt}` } };
}

// ---------- Time options (next ~50h, 30-min steps, ET) ----------
function buildTimeChoices() {
  const out = [];
  const now = new Date();
  const t = new Date(now.getTime());
  const m = t.getMinutes();
  t.setMinutes(m < 30 ? 30 : 60, 0, 0);
  for (let i = 0; i < 100; i++) {
    const d = new Date(t.getTime() + i * 30 * 60 * 1000);
    const label =
      d.toLocaleString('en-US', {
        weekday: 'short', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: 'America/New_York',
      }) + ' ET';
    out.push({ label, value: label });
  }
  return out;
}

// ---------- SOCOM 2 maps ----------
const SOCOM2_MAPS = [
  'Frostfire - Suppression','Blizzard - Demolition','Night Stalker - Demolition','Desert Glory - Extraction',
  "Rat's Nest - Suppression",'Abandoned - Suppression','The Ruins - Demolition','Blood Lake - Extraction',
  'Bitter Jungle - Demolition','Death Trap - Extraction','Sandstorm - Breach','Fish Hook - Extraction',
  'Crossroads - Demolition','Crossroads Night - Demolition','Fox Hunt - Escort','The Mixer - Escort',
  'Vigilance - Suppression','Requiem - Demolition','Guidance - Escort','Chain Reaction - Suppression',
  'Sujo - Breach','Enowapi - Breach','Shadow Falls - Suppression',
];

// ---------- Minimal Sheets reads for /summary ----------
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}
async function getValues(range) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEETS_ID,
    range,
  });
  return res.data.values || [];
}
async function loadWarBundle(warId) {
  const id = String(warId);
  const [wars, players, maps] = await Promise.all([
    getValues('wars!A2:F'),         // war_id | opponent | format | start_et | locked_at | vod_url
    getValues('war_players!A2:D'),  // war_id | user_id | name | role
    getValues('maps!A2:E'),         // war_id | map_order | map_name | our_score | opp_score
  ]);
  const w = wars.find((r) => r[0] === id);
  if (!w) return null;
  const war = { id, opponent: w[1] || 'TBD', format: (w[2] || '').toUpperCase(), start_et: w[3] || '', locked_at: w[4] || '', vod_url: w[5] || '' };
  const roster = {
    starters: players.filter((r) => r[0] === id && r[3] === 'starter').map((r) => ({ user_id: r[1], name: r[2] })),
    backups:  players.filter((r) => r[0] === id && r[3] === 'backup').map((r) => ({ user_id: r[1], name: r[2] })),
  };
  const warMaps = maps.filter((r) => r[0] === id).map((r) => ({
    order: parseInt(r[1] || '0', 10),
    name: r[2] || `Map ${r[1]}`,
    our: Number.isFinite(parseInt(r[3], 10)) ? parseInt(r[3], 10) : null,
    opp: Number.isFinite(parseInt(r[4], 10)) ? parseInt(r[4], 10) : null,
  })).sort((a,b)=>a.order-b.order);
  let ourWins=0, oppWins=0;
  for (const m of warMaps) { if (m.our==null||m.opp==null) continue; if (m.our>m.opp) ourWins++; else if (m.opp>m.our) oppWins++; }
  return { war, roster, maps: warMaps, tally: { ourWins, oppWins } };
}
function buildResultEmbed(bundle) {
  const { war, roster, maps, tally } = bundle;
  const mapLines = maps.length ? maps.map(m => `**${m.order}. ${m.name}** — ${m.our==null||m.opp==null ? '—' : `${m.our}–${m.opp}`}`).join('\n') : '_No maps recorded_';
  const startersStr = roster.starters.length ? roster.starters.map(p => p.name).join(', ') : '_none_';
  const backupsStr  = roster.backups.length  ? roster.backups.map(p => p.name).join(', ')  : '_none_';
  const title = (tally.ourWins + tally.oppWins) > 0 ? `Match Result vs ${war.opponent} — ${tally.ourWins}-${tally.oppWins}` : `Match vs ${war.opponent} — Pending Scores`;
  return {
    title,
    description: `**War ID:** ${war.id}\n**Format:** ${war.format || 'TBD'}\n**Start:** ${war.start_et || 'TBD'}${war.vod_url ? `\n**VOD:** ${war.vod_url}` : ''}`,
    fields: [
      { name: 'Starters', value: startersStr, inline: false },
      { name: 'Backups', value: backupsStr, inline: false },
      { name: 'Maps', value: mapLines, inline: false },
    ],
    footer: { text: `War #${war.id}` },
  };
}

// ---------- In-memory state ----------
const wizardState = new Map();      // userId -> { warId, teamSize, format, opponent, startET }
const pools = new Map();            // messageId -> { warId, signups: Map<userId, {name, tsMs}> }
const warToMessage = new Map();     // warId -> signup messageId
const warToThread = new Map();      // warId -> threadId
const pendingLocks = new Map();     // adminId -> { warId, starters, backups, format, stepMsgId, map1..mapN }
const pendingManual = new Map();    // adminId -> { warId }

// ---------- Sticky component builders ----------
function teamSizeMenu(selected) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:w:teamsize')
      .setPlaceholder('Select Team Size (6 / 7 / 8)')
      .addOptions(
        { label: '6v6', value: '6', default: selected === '6' },
        { label: '7v7', value: '7', default: selected === '7' },
        { label: '8v8', value: '8', default: selected === '8' },
      )
  );
}
function formatMenu(selected) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:w:format')
      .setPlaceholder('Select Match Format (BO3 / BO5)')
      .addOptions(
        { label: 'Best of 3', value: 'BO3', default: selected === 'BO3' },
        { label: 'Best of 5', value: 'BO5', default: selected === 'BO5' },
      )
  );
}
function timeMenu(selected) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:w:time')
      .setPlaceholder('Pick a start time (ET)')
      .addOptions(...buildTimeChoices().map(c => ({ label: c.label, value: c.value, default: selected === c.value })))
  );
}
function nextButtons(enabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wb:w:next').setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(!enabled),
    new ButtonBuilder().setCustomId('wb:w:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}
function buildMapSelect(customId, selected) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Pick a map')
    .addOptions(...SOCOM2_MAPS.map(m => ({ label: m, value: m, default: selected === m })));
  return new ActionRowBuilder().addComponents(menu);
}
function buildMapDraftComponents(format = 'BO3', current = {}) {
  const n = format === 'BO5' ? 5 : 3;
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push(buildMapSelect(`wb:d:${i}`, current[`map${i}`]));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('wb:d:finalize').setLabel('Finalize Roster & Maps').setStyle(ButtonStyle.Success)));
  return rows;
}

// ---------- Register commands ----------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('warbot')
      .setDescription('WarBot commands')
      .addSubcommand(s => s.setName('new').setDescription('Create a War Sign-up (wizard)'))
      .addSubcommand(s =>
        s.setName('select').setDescription('Admin: lock roster for a specific war')
         .addIntegerOption(o => o.setName('war_id').setDescription('War ID to manage').setRequired(true))
         .addStringOption(o => o.setName('mode').setDescription('How to select starters').addChoices(
           { name: 'Auto: first N to sign up', value: 'auto' },
           { name: 'Manual: I will pick', value: 'manual' }
         ).setRequired(true))
         .addIntegerOption(o => o.setName('team_size').setDescription('N for auto (6,7,8). Defaults to creation choice.').setMinValue(6).setMaxValue(8))
      )
      .addSubcommand(s =>
        s.setName('summary').setDescription('Post a public summary to results channel (reads from Sheets)')
         .addIntegerOption(o => o.setName('war_id').setDescription('War ID').setRequired(true))
         .addBooleanOption(o => o.setName('preview_only').setDescription('Reply privately instead of posting'))
      )
      .addSubcommand(s =>
        s.setName('stats').setDescription('View player stats')
         .addUserOption(o => o.setName('player').setDescription('Player to view').setRequired(true))
      ),
  ].map(c => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log('✅ Registered /warbot commands');
}

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});
client.on('error', (e) => console.error('DISCORD CLIENT ERROR:', e?.stack || e));
client.on('shardError', (e) => console.error('DISCORD SHARD ERROR:', e?.stack || e));

// ---------- Interactions ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand() && interaction.commandName === 'warbot') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'new') {
        // War ID (with UTC timestamp fallback)
        let warId = await getNextWarId().catch(() => null);
        if (!warId && warId !== 0) {
          const now = new Date();
          warId = Number(`${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,'0')}${String(now.getUTCDate()).padStart(2,'0')}${String(now.getUTCHours()).padStart(2,'0')}${String(now.getUTCMinutes()).padStart(2,'0')}`);
        }
        // Wizard state
        wizardState.set(interaction.user.id, { warId, teamSize: null, format: null, opponent: null, startET: null });

        await interaction.reply({
          content:
            `🧭 **War Wizard** — **War ID ${warId}**\n` +
            `1) Choose **Team Size**\n2) Choose **Format**\n3) Enter **Opponent** & **Start Time**\n\n` +
            `Your selections will remain visible below.`,
          components: [teamSizeMenu(null), formatMenu(null), nextButtons(false)],
          ephemeral: true,
        });
        return;
      }

      if (sub === 'select') {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!isAdminish(member)) {
          await interaction.reply({ content: '⛔ You do not have permission to manage rosters.', ephemeral: true });
          return;
        }
        const warId = interaction.options.getInteger('war_id', true);
        const mode = interaction.options.getString('mode', true);
        const teamSizeOpt = interaction.options.getInteger('team_size') || null;

        const messageId = warToMessage.get(String(warId));
        const pool = messageId ? pools.get(messageId) : null;

        if (mode === 'auto') {
          const N = teamSizeOpt || 8;
          if (!pool || pool.signups.size === 0) {
            await interaction.reply({ content: `❌ No live pool found or no signups for War ID ${warId}. Try manual mode.`, ephemeral: true });
            return;
          }
          const entries = [...pool.signups.entries()].sort((a, b) => a[1].tsMs - b[1].tsMs);
          const starters = entries.slice(0, N).map(([userId, v]) => ({ userId, name: v.name }));
          const backups = entries.slice(N).map(([userId, v]) => ({ userId, name: v.name }));

          const msg = await interaction.reply({
            content: `🔐 Auto-selecting **${N}** starters for **War ID ${warId}**.\nPick the maps (last must be Crossroads / Crossroads Night).`,
            components: buildMapDraftComponents('BO3'),
            ephemeral: true,
            fetchReply: true,
          });
          pendingLocks.set(interaction.user.id, { warId, starters, backups, format: 'BO3', stepMsgId: msg.id });
          return;
        } else {
          const modal = new ModalBuilder().setCustomId('wb:m:manual').setTitle(`Manual Roster — War ${warId}`);
          const starters = new TextInputBuilder().setCustomId('wb:m:starters').setLabel('Starters (comma-separated @mentions or names)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(400);
          const backups  = new TextInputBuilder().setCustomId('wb:m:backups').setLabel('Backups (optional, comma-separated)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400);
          modal.addComponents(new ActionRowBuilder().addComponents(starters), new ActionRowBuilder().addComponents(backups));
          pendingManual.set(interaction.user.id, { warId });
          await interaction.showModal(modal);
          return;
        }
      }

      if (sub === 'summary') {
        const warId = interaction.options.getInteger('war_id', true);
        const previewOnly = interaction.options.getBoolean('preview_only') || false;

        await interaction.deferReply({ ephemeral: true });
        const bundle = await loadWarBundle(warId);
        if (!bundle) {
          await interaction.editReply({ content: `❌ Could not find war_id=${warId} in the Sheet.` });
          return;
        }
        const embed = buildResultEmbed(bundle);
        if (previewOnly) {
          await interaction.editReply({ embeds: [embed], content: '🔍 Preview only (not posted publicly).' });
        } else {
          const chId = process.env.RESULTS_CHANNEL_ID;
          const ch = chId ? await client.channels.fetch(chId).catch(() => null) : null;
          if (!ch || !ch.isTextBased()) {
            await interaction.editReply({ content: '❌ RESULTS_CHANNEL_ID is missing or invalid.' });
            return;
          }
          await ch.send({ embeds: [embed] });
          await interaction.editReply({ content: `✅ Posted to <#${chId}>`, embeds: [embed] });
        }
        return;
      }

      if (sub === 'stats') {
        const user = interaction.options.getUser('player', true);
        const stats = await getPlayerStats(user.id);
        await interaction.reply({
          embeds: [{
            title: `📊 Stats for ${user.username}`,
            fields: [{ name: 'Totals', value: `Wars: ${stats.totals.wars}\nWins: ${stats.totals.wins}\nLosses: ${stats.totals.losses}\nMap Wins: ${stats.totals.mapWins}\nMap Losses: ${stats.totals.mapLosses}\nNo-shows: ${stats.totals.noshows}` }],
          }],
          ephemeral: true,
        });
        return;
      }
    }

    // Wizard dropdowns
    if (interaction.isStringSelectMenu()) {
      const uid = interaction.user.id;
      const st = wizardState.get(uid);
      if (!st) return;

      if (interaction.customId === 'wb:w:teamsize') {
        st.teamSize = interaction.values[0];
        await interaction.update({
          content: `🧭 **War Wizard** — **War ID ${st.warId}**\nTeam Size: **${st.teamSize || '—'}** | Format: **${st.format || '—'}**\nSelect both, then click **Next**.`,
          components: [teamSizeMenu(st.teamSize), formatMenu(st.format), nextButtons(!!(st.teamSize && st.format))],
        });
        return;
      }
      if (interaction.customId === 'wb:w:format') {
        st.format = interaction.values[0];
        await interaction.update({
          content: `🧭 **War Wizard** — **War ID ${st.warId}**\nTeam Size: **${st.teamSize || '—'}** | Format: **${st.format || '—'}**\nSelect both, then click **Next**.`,
          components: [teamSizeMenu(st.teamSize), formatMenu(st.format), nextButtons(!!(st.teamSize && st.format))],
        });
        return;
      }
      if (interaction.customId === 'wb:w:time') {
        st.startET = interaction.values[0];
        await interaction.update({
          content: `🧭 **War Wizard** — **War ID ${st.warId}**\nOpponent: **${st.opponent || '—'}**\nStart (ET): **${st.startET || '—'}**\nClick **Create Sign-up** to post.`,
          components: [
            timeMenu(st.startET),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('wb:w:create').setLabel('Create Sign-up').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId('wb:w:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
        return;
      }
    }

    // Wizard buttons / modal
    if (interaction.isButton()) {
      const uid = interaction.user.id;
      const st = wizardState.get(uid);

      if (interaction.customId === 'wb:w:cancel') {
        wizardState.delete(uid);
        await interaction.update({ content: '❌ Wizard cancelled.', components: [] });
        return;
      }

      if (interaction.customId === 'wb:w:next') {
        if (!st || !st.teamSize || !st.format) {
          await interaction.reply({ content: 'Please choose team size and format first.', ephemeral: true });
          return;
        }
        const modal = new ModalBuilder().setCustomId('wb:w:oppmodal').setTitle('Enter Opponent');
        const opp = new TextInputBuilder().setCustomId('wb:w:opptxt').setLabel('Opponent name').setStyle(TextInputStyle.Short).setMaxLength(50).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(opp));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === 'wb:w:create') {
        if (!st || !st.opponent || !st.startET) {
          await interaction.reply({ content: 'Please enter opponent and pick a start time first.', ephemeral: true });
          return;
        }
        const channelId = process.env.WAR_CHANNEL_ID;
        const channel = channelId ? await client.channels.fetch(channelId).catch(()=>null) : null;
        if (!channel || !channel.isTextBased()) {
          await interaction.reply({ content: '❌ WAR_CHANNEL_ID is missing or invalid.', ephemeral: true });
          return;
        }

        // Optional ping when pool opens (auto-delete)
        if (process.env.PING_POOL_ROLE_ID) {
          const pingMsg = await channel.send({ content: `<@&${process.env.PING_POOL_ROLE_ID}>` }).catch(()=>null);
          if (pingMsg && CLEANUP_MS > 0) setTimeout(() => pingMsg.delete().catch(()=>{}), CLEANUP_MS);
        }

        let embed = {
          title: `War Sign-up #${st.warId}`,
          description:
            `**War ID:** ${st.warId}\n` +
            `**Opponent:** ${st.opponent}\n` +
            `**Format:** ${st.format}\n` +
            `**Team Size:** ${st.teamSize}v${st.teamSize}\n` +
            `**Start (ET):** ${st.startET}\n\n` +
            `React with 👍 to **join** (timestamp recorded).\nReact with 🛑 to **cancel this sign-up**.\n\n` +
            `Admins: use \`/warbot select war_id:${st.warId}\` to lock this war.`,
        };
        embed = embedWithWarId(embed, st.warId);

        const msg = await channel.send({ embeds: [embed] });
        warToMessage.set(String(st.warId), msg.id);
        pools.set(msg.id, { warId: st.warId, signups: new Map() });

        // Keep channel clean: thread per war
        if (AUTO_THREAD && msg.hasThread === false && msg.startThread) {
          try {
            const thread = await msg.startThread({ name: `war-${st.warId}-chat`, autoArchiveDuration: ARCHIVE_MINUTES });
            warToThread.set(String(st.warId), thread.id);
            await thread.send(`Thread created for **War #${st.warId}**. Discussion here to keep <#${channel.id}> clean.`);
          } catch (e) {
            console.warn('Could not start thread:', e?.message || e);
          }
        }

        await msg.react('👍').catch(()=>{});
        await msg.react('🛑').catch(()=>{});

        await interaction.update({
          content:
            `✅ **War Sign-up #${st.warId}** created in <#${channel.id}>.\n` +
            `Opponent: **${st.opponent}** | Format: **${st.format}** | Team: **${st.teamSize}v${st.teamSize}** | Start: **${st.startET}**`,
          components: [],
        });
        wizardState.delete(uid);
        return;
      }
    }

    // Opponent modal
    if (interaction.isModalSubmit() && interaction.customId === 'wb:w:oppmodal') {
      const uid = interaction.user.id;
      const st = wizardState.get(uid);
      if (!st) return;
      st.opponent = interaction.fields.getTextInputValue('wb:w:opptxt');
      await interaction.reply({
        content: `🧭 **War Wizard** — **War ID ${st.warId}**\nOpponent: **${st.opponent}**\nPick a **Start Time (ET)** below.`,
        components: [timeMenu(st.startET), nextButtons(false)],
        ephemeral: true,
      });
      return;
    }

    // Manual lock modal
    if (interaction.isModalSubmit() && interaction.customId === 'wb:m:manual') {
      const adminId = interaction.user.id;
      const pending = pendingManual.get(adminId);
      if (!pending) {
        await interaction.reply({ content: 'This manual lock session expired. Please run /warbot select again.', ephemeral: true });
        return;
      }
      pendingManual.delete(adminId);

      const warId = pending.warId;
      const startersRaw = interaction.fields.getTextInputValue('wb:m:starters') || '';
      const backupsRaw  = interaction.fields.getTextInputValue('wb:m:backups') || '';

      const parseList = (s) => s.split(',').map(v => v.trim()).filter(Boolean).map(v => v.replace(/^<@!?(\d+)>$/, '$1'));
      const starters = await resolveUsers(interaction.guild, parseList(startersRaw));
      const backups  = await resolveUsers(interaction.guild, parseList(backupsRaw));

      const msg = await interaction.reply({
        content: `📝 **Manual roster set** for **War ${warId}**.\nPick the map order (last must be Crossroads / Crossroads Night).`,
        components: buildMapDraftComponents('BO3'),
        ephemeral: true,
        fetchReply: true,
      });
      pendingLocks.set(adminId, { warId, starters, backups, format: 'BO3', stepMsgId: msg.id });
      return;
    }

    // Map draft selects & finalize
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('wb:d:')) {
      const adminId = interaction.user.id;
      const pend = pendingLocks.get(adminId);
      if (!pend) return;
      const idx = Number(interaction.customId.split(':')[2]);
      pend[`map${idx}`] = interaction.values[0];
      await interaction.update({ components: buildMapDraftComponents(pend.format, pend) });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'wb:d:finalize') {
      const adminId = interaction.user.id;
      const pend = pendingLocks.get(adminId);
      if (!pend) {
        await interaction.reply({ content: 'This draft session expired. Run /warbot select again.', ephemeral: true });
        return;
      }

      const { warId, starters, backups, format } = pend;
      const needed = format === 'BO5' ? 5 : 3;
      const selectedMaps = [];
      for (let i = 1; i <= needed; i++) {
        const name = pend[`map${i}`];
        if (!name) {
          await interaction.reply({ content: `Please select Map ${i} before finalizing.`, ephemeral: true });
          return;
        }
        selectedMaps.push(name);
      }
      const last = selectedMaps[selectedMaps.length - 1];
      if (last !== 'Crossroads - Demolition' && last !== 'Crossroads Night - Demolition') {
        await interaction.reply({ content: `The last map must be Crossroads or Crossroads Night.`, ephemeral: true });
        return;
      }

      // Persist to Sheets (opponent/startET can be pushed if you also store them at creation)
      await pushWarLock({ warId, opponent: 'TBD', format, startET: 'TBD', starters, backups });
      for (let i = 0; i < selectedMaps.length; i++) await pushAddedMap({ warId, mapOrder: i + 1, mapName: selectedMaps[i] });

      // DMs
      await dmList(starters, `✅ You have been selected as a **starter** for War #${warId}.`);
      await dmList(backups,  `🕒 You are a **backup** for War #${warId}. Stay ready!`);

      // Optional roster ping (auto-delete)
      if (process.env.PING_ROSTER_ROLE_ID) {
        const chId = process.env.WAR_CHANNEL_ID;
        const ch = chId ? await client.channels.fetch(chId).catch(()=>null) : null;
        if (ch && ch.isTextBased()) {
          const pingMsg = await ch.send({ content: `<@&${process.env.PING_ROSTER_ROLE_ID}> Roster locked for **War #${warId}**.` }).catch(()=>null);
          if (pingMsg && CLEANUP_MS > 0) setTimeout(() => pingMsg.delete().catch(()=>{}), CLEANUP_MS);
        }
      }

      // Update signup embed with rosters (keep War ID visible)
      const msgId = warToMessage.get(String(warId));
      if (msgId) {
        try {
          const ch = await client.channels.fetch(process.env.WAR_CHANNEL_ID).catch(()=>null);
          const msg = ch ? await ch.messages.fetch(msgId).catch(()=>null) : null;
          if (msg) {
            let base = msg.embeds[0]?.toJSON?.() || { title: `War Sign-up #${warId}`, description: '' };
            const startersStr = starters.map(p => p.name).join(', ') || '_none_';
            const backupsStr  = backups.map(p  => p.name).join(', ')  || '_none_';
            base.description = base.description.replace(/\n?\*\*Signed up.*$/s, '') +
              `\n\n**Starters:** ${startersStr}\n**Backups:** ${backupsStr}\n_(Sign-ups remain open for backups)_`;
            base = embedWithWarId(base, warId);
            await msg.edit({ embeds: [base] });
          }
        } catch (e) { console.error('Update signup after lock failed:', e?.stack || e); }
      }

      pendingLocks.delete(adminId);
      await interaction.reply({ content: `✅ Roster locked for **War #${warId}**. DMs sent.`, ephemeral: true });
      return;
    }
  } catch (err) {
    console.error('INTERACTION ERROR:', err?.stack || err);
    if (interaction.isRepliable?.()) {
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '⚠️ Something went wrong. Try again.', flags: 1 << 6 });
        } else if (interaction.deferred) {
          await interaction.editReply({ content: '⚠️ Something went wrong. Try again.' });
        }
      } catch {}
    }
  }
});

// ---------- Reaction handlers (👍 join / 🛑 cancel) ----------
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    const msg = reaction.message;
    if (!msg?.id) return;
    const pool = pools.get(msg.id);
    if (!pool) return;

    if (reaction.emoji.name === '👍') {
      pool.signups.set(user.id, { name: user.username, tsMs: Date.now() });

      const lines = [...pool.signups.entries()].sort((a,b)=>a[1].tsMs-b[1].tsMs).map(([_,v])=>{
        const dt = new Date(v.tsMs).toLocaleString('en-US',{hour:'numeric',minute:'2-digit',hour12:true,month:'numeric',day:'numeric',timeZone:'America/New_York'});
        return `${v.name} (${dt} ET)`;
      });

      let base = msg.embeds[0]?.toJSON?.() || { title: `War Sign-up #${pool.warId}`, description: '' };
      const signed = `**Signed up (earliest first):**\n${lines.join('\n') || '_none yet_'}`;
      base.description = base.description.replace(/\n?\*\*Signed up.*$/s, '') + `\n\n${signed}`;
      base = embedWithWarId(base, pool.warId);
      await msg.edit({ embeds: [base] }).catch(()=>{});
    }

    if (reaction.emoji.name === '🛑') {
      // delete thread if exists
      try {
        const threadId = warToThread.get(String(pool.warId));
        if (threadId) {
          const thread = await client.channels.fetch(threadId).catch(()=>null);
          if (thread && thread.isThread()) await thread.delete().catch(()=>{});
          warToThread.delete(String(pool.warId));
        }
      } catch {}
      await msg.delete().catch(()=>{});
      pools.delete(msg.id);
      warToMessage.forEach((mid, wid) => { if (mid === msg.id) warToMessage.delete(wid); });
    }
  } catch (e) {
    console.error('REACTION ADD ERROR:', e?.stack || e);
  }
});
client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    const msg = reaction.message;
    if (!msg?.id) return;
    const pool = pools.get(msg.id);
    if (!pool) return;

    if (reaction.emoji.name === '👍') {
      pool.signups.delete(user.id);

      const lines = [...pool.signups.entries()].sort((a,b)=>a[1].tsMs-b[1].tsMs).map(([_,v])=>{
        const dt = new Date(v.tsMs).toLocaleString('en-US',{hour:'numeric',minute:'2-digit',hour12:true,month:'numeric',day:'numeric',timeZone:'America/New_York'});
        return `${v.name} (${dt} ET)`;
      });

      let base = msg.embeds[0]?.toJSON?.() || { title: `War Sign-up #${pool.warId}`, description: '' };
      const signed = `**Signed up (earliest first):**\n${lines.join('\n') || '_none yet_'}`;
      base.description = base.description.replace(/\n?\*\*Signed up.*$/s, '') + `\n\n${signed}`;
      base = embedWithWarId(base, pool.warId);
      await msg.edit({ embeds: [base] }).catch(()=>{});
    }
  } catch (e) {
    console.error('REACTION REMOVE ERROR:', e?.stack || e);
  }
});

// ---------- Helpers ----------
async function resolveUsers(guild, arr) {
  const out = [];
  for (const token of arr) {
    let userId = token;
    let name = token;
    if (/^\d{15,20}$/.test(token)) {
      const m = await guild.members.fetch(token).catch(()=>null);
      if (m) { userId = m.id; name = m.user.username; }
    } else if (token.startsWith('@')) {
      const q = token.slice(1).toLowerCase();
      const m = guild.members.cache.find(u => u.user.username.toLowerCase() === q);
      if (m) { userId = m.id; name = m.user.username; }
    }
    out.push({ userId, name });
  }
  return out;
}
async function dmList(list, text) {
  for (const p of list) {
    try {
      const u = await client.users.fetch(p.userId).catch(()=>null);
      if (u) await u.send(text).catch(()=>{});
    } catch {}
  }
}

// ---------- Startup ----------
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await initSheets();
  initDB();
  await registerCommands();
});
client.login(process.env.DISCORD_TOKEN);

// index.js — WarBot full build with /help, new, roster, maps, end war, Sheets & DB
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
  PermissionsBitField,
} from 'discord.js';

import {
  initDB,
  // Optional DB helpers; if some are missing in your db.js, the try/catch around calls will keep things running.
  recordLockedWar,
  addMapsDraft,
  updateMapScore,
  setVOD,
  addSub,
  addNoShow,
  getMaps,
  getPlayerStats,
} from './db.js';

import {
  initSheets,
  pushWarLock,
  pushMapScore,
  pushAddedMap,
  pushVOD,
  pushSub,
  pushNoShow,
} from './sheets.js';

/* ----------------------- CONFIG / CONSTANTS ----------------------- */

const SOCOM_MAPS = [
  'Frostfire - Suppression',
  'Blizzard - Demolition',
  'Night Stalker - Demolition',
  'Desert Glory - Extraction',
  "Rat's Nest - Suppression",
  'Abandoned - Suppression',
  'The Ruins - Demolition',
  'Blood Lake - Extraction',
  'Bitter Jungle - Demolition',
  'Death Trap - Extraction',
  'Sandstorm - Breach',
  'Fish Hook - Extraction',
  'Crossroads - Demolition',
  'Crossroads Night - Demolition',
  'Fox Hunt - Escort',
  'The Mixer - Escort',
  'Vigilance - Suppression',
  'Requiem - Demolition',
  'Guidance - Escort',
  'Chain Reaction - Suppression',
  'Sujo - Breach',
  'Enowapi - Breach',
  'Shadow Falls - Suppression',
];

const LAST_MAP_CHOICES = ['Crossroads - Demolition', 'Crossroads Night - Demolition'];

const SIDE_CHOICES = [
  { label: 'SEALs', value: 'SEALs' },
  { label: 'Terrorists', value: 'Terrorists' },
];

/* ----------------------- STATE ----------------------- */

// In-memory state keyed by messageId of the signup post
const wars = new Map();
/*
war = {
  id: number,
  messageId: string,
  channelId: string,
  opponent: string,
  format: 'bo3'|'bo5',
  teamSize: 6|7|8,
  startISO: string,
  startET: string,

  pool: Map<userId, {name, joinedISO}>,
  starters: string[], // userIds
  backups: string[],  // userIds
  mapsPlanned: string[], // selected names length=3/5 (maybe empty until set)
  locked: boolean, // roster locked flag
}
*/
let nextWarId = 1;

// for multi-step map planning per war (admin flow)
const mapPlanProgress = new Map(); // key: interaction.user.id + warMessageId -> { warMsgId, needed, stepIndex, picks[] }

// for add-map result flow (keeper/admin)
const addMapSession = new Map(); // key: interaction.user.id + warMsgId -> temp info

/* ----------------------- CLIENT ----------------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

/* ----------------------- UTILS ----------------------- */

const isAdminish = (member) => {
  if (!member) return false;
  const roles = new Set(member.roles.cache.map(r => r.id));
  const allowed = [
    process.env.ROLE_ADMIN,
    process.env.ROLE_MANAGER,
    process.env.ROLE_KEEPER,
    process.env.ROLE_CAPTAIN,
  ].filter(Boolean);
  return allowed.some(id => roles.has(id)) || member.permissions.has(PermissionsBitField.Flags.Administrator);
};

function etString(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function renderNames(ids, guild) {
  return ids.map(id => {
    const m = guild.members.cache.get(id);
    return m ? `${m.displayName} (<@${id}>)` : `<@${id}>`;
  }).join(', ');
}

function poolArray(war) {
  return [...war.pool.entries()]
    .sort((a, b) => new Date(a[1].joinedISO) - new Date(b[1].joinedISO))
    .map(([uid, o]) => ({ userId: uid, ...o }));
}

async function updateSignupEmbed(message) {
  const war = wars.get(message.id);
  if (!war) return;

  const guild = message.guild;
  const startersText = war.starters.length ? renderNames(war.starters, guild) : '_none selected yet_';
  const backupsText = war.backups.length ? renderNames(war.backups, guild) : '_none_';

  const poolText = poolArray(war).map((p, idx) => {
    const when = new Date(p.joinedISO).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
    return `${idx + 1}. <@${p.userId}> — ${when} ET`;
  }).join('\n') || '_no one yet — react 👍 to join_';

  const mapsPlanned = war.mapsPlanned?.length ? war.mapsPlanned : [];

  const embed = new EmbedBuilder()
    .setTitle(`War Sign-up #${war.id}`)
    .setColor(war.locked ? 0xe67e22 : 0x2ecc71)
    .setDescription(
      [
        `**Opponent:** ${war.opponent}`,
        `**Format:** ${war.format.toUpperCase()}`,
        `**Start (ET):** ${war.startET}`,
        `**Team:** ${war.teamSize}v${war.teamSize}`,
        '',
        `**Starters (${war.starters.length}/${war.teamSize})**`,
        startersText,
        '',
        `**Backups (${war.backups.length})**`,
        backupsText,
        '',
        '**In Pool**',
        poolText,
        '',
        `**Planned Maps (${mapsPlanned.length || (war.format === 'bo3' ? 3 : 5)})**`,
        mapsPlanned.length ? mapsPlanned.map((m, i) => `${i + 1}. ${m}`).join('\n') : '_not set yet_',
      ].join('\n')
    )
    .setFooter({ text: war.locked ? 'Roster locked (admins can unlock if needed)' : 'Roster open' });

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`roster:auto:${message.id}`).setLabel('Auto-pick First N').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`roster:choose:${message.id}`).setLabel('Choose Roster').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`maps:set:${message.id}`).setLabel('Set Maps').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`maps:add:${message.id}`).setLabel('Add Map Result').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`war:end:${message.id}`).setLabel('End War').setStyle(ButtonStyle.Danger),
  );

  const controls2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`roster:unlock:${message.id}`).setLabel('Unlock Roster').setStyle(ButtonStyle.Secondary),
  );

  await message.edit({ embeds: [embed], components: [controls, controls2] });
}

/* ----------------------- REGISTER COMMANDS ----------------------- */

async function registerCommands() {
  const commands = [
    {
      name: 'warbot',
      description: 'WarBot commands',
      options: [
        { type: 1, name: 'new', description: 'Create a new War Sign-up' },
        { type: 1, name: 'select', description: 'Admin: pick/adjust roster' },
        { type: 1, name: 'map_add', description: 'Keeper: add a map row (manual)' },
        { type: 1, name: 'sub_add', description: 'Keeper: record a substitution' },
        { type: 1, name: 'noshow_add', description: 'Keeper: record a no-show' },
        { type: 1, name: 'vod_set', description: 'Keeper: set a VOD link' },
        { type: 1, name: 'stats_player', description: 'View player stats' },
        { type: 1, name: 'help', description: 'Show WarBot help and quick reference' },
      ],
    },
  ];
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('✅ Registered /warbot commands');
}

/* ----------------------- READY ----------------------- */

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  initDB();
  await initSheets();
  await registerCommands();
});

/* ----------------------- INTERACTIONS ----------------------- */

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'warbot') return;
      const sub = interaction.options.getSubcommand();

      /* ---------- HELP ---------- */
      if (sub === 'help') {
        const embed = new EmbedBuilder()
          .setTitle('WarBot — Quick Reference')
          .setColor(0x5865f2)
          .setDescription(
            [
              '**Users**',
              '• React 👍 to sign up; unreact to drop out.',
              '• You will be DM’d if selected as **starter** or **backup**.',
              '',
              '**Admins / War Managers**',
              '• `/warbot new` — create a sign-up (team size, format, opponent, time).',
              '• `/warbot select id:<#>` — pick roster & set maps (last map Crossroads/Crossroads Night).',
              '• **Unlock Roster** button — adjust if someone drops.',
              '• **End War** button — log scores, sides, subs, VOD; results auto-post.',
              '',
              '**Keepers / Captains**',
              '• Can **End War** and log results/subs.',
              '• Captains can also cancel with 🛑 when necessary.',
              '',
              '**Cancel a War**',
              '• React 🛑 on the sign-up (Admins/Managers/Keepers/Captains only).',
            ].join('\n')
          );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('help:full')
            .setLabel('Show full tutorial (DM to you)')
            .setStyle(ButtonStyle.Primary)
        );

        return interaction.reply({ embeds: [embed], components: [row] });
      }

      /* ---------- NEW (create sign-up) ---------- */
      if (sub === 'new') {
        if (!isAdminish(interaction.member)) {
          return interaction.reply({ ephemeral: true, content: 'You do not have permission to create wars.' });
        }

        const modal = new ModalBuilder().setCustomId('new:modal').setTitle('Create War Sign-up');

        const sizeInput = new TextInputBuilder()
          .setCustomId('new:size')
          .setLabel('Team size (6, 7, or 8)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const formatInput = new TextInputBuilder()
          .setCustomId('new:format')
          .setLabel('Format (Bo3 or Bo5)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const oppInput = new TextInputBuilder()
          .setCustomId('new:opp')
          .setLabel('Opponent name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row1 = new ActionRowBuilder().addComponents(sizeInput);
        const row2 = new ActionRowBuilder().addComponents(formatInput);
        const row3 = new ActionRowBuilder().addComponents(oppInput);
        modal.addComponents(row1, row2, row3);

        await interaction.showModal(modal);
        return;
      }

      /* ---------- SELECT (stub) ---------- */
      if (sub === 'select') {
        if (!isAdminish(interaction.member)) {
          return interaction.reply({ ephemeral: true, content: 'You do not have permission for roster selection.' });
        }
        return interaction.reply({ ephemeral: true, content: 'Open the war sign-up message and use the buttons there.' });
      }

      /* ---------- Other keeper stubs (you can wire if desired) ---------- */
      if (sub === 'map_add') return interaction.reply({ ephemeral: true, content: 'Use **Add Map Result** button on the war message.' });
      if (sub === 'sub_add') return interaction.reply({ ephemeral: true, content: 'Substitutions are logged in the **End War** flow.' });
      if (sub === 'noshow_add') return interaction.reply({ ephemeral: true, content: 'No-shows can be recorded in the **End War** flow.' });
      if (sub === 'vod_set') return interaction.reply({ ephemeral: true, content: 'Set VOD in the **End War** flow.' });
      if (sub === 'stats_player') return interaction.reply({ ephemeral: true, content: 'Check Google Sheets for now (in-Discord stats can be added later).' });
    }

    /* ---------- MODALS ---------- */
    if (interaction.isModalSubmit()) {
      // /warbot new -> step 1 modal
      if (interaction.customId === 'new:modal') {
        const size = interaction.fields.getTextInputValue('new:size').trim();
        const format = interaction.fields.getTextInputValue('new:format').trim().toLowerCase();
        const opp = interaction.fields.getTextInputValue('new:opp').trim();

        const sizeNum = Number(size);
        if (![6, 7, 8].includes(sizeNum)) {
          return interaction.reply({ ephemeral: true, content: 'Team size must be 6, 7, or 8.' });
        }
        if (!(format === 'bo3' || format === 'bo5')) {
          return interaction.reply({ ephemeral: true, content: 'Format must be Bo3 or Bo5.' });
        }

        // Step 2: Time dropdown pages
        const options = [];
        const now = new Date();
        now.setMinutes(now.getMinutes() - (now.getMinutes() % 30), 0, 0);
        const slots = 72 * 2;
        for (let i = 0; i < slots; i++) {
          const d = new Date(now.getTime() + i * 30 * 60 * 1000);
          const et = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true, month: 'short', day: '2-digit' });
          options.push({ label: et, value: d.toISOString() });
        }

        const pageOptions = options.slice(0, 25);
        const select = new StringSelectMenuBuilder()
          .setCustomId(`new:time:${sizeNum}:${format}:${encodeURIComponent(opp)}`)
          .setPlaceholder('Select start time (ET)')
          .setMinValues(1).setMaxValues(1)
          .addOptions(pageOptions);

        const btns = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`new:timepage:1:${sizeNum}:${format}:${encodeURIComponent(opp)}`).setLabel('Next Page').setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({ ephemeral: true, content: 'Choose a start time (ET).', components: [new ActionRowBuilder().addComponents(select), btns] });
      }

      // Choose roster modal
      if (interaction.customId.startsWith('roster:choose:modal:')) {
        const [, , , warMsgId] = interaction.customId.split(':');
        const war = wars.get(warMsgId);
        if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });

        const startersText = interaction.fields.getTextInputValue('roster:starters') || '';
        const backupsText = interaction.fields.getTextInputValue('roster:backups') || '';

        const parseList = (txt) => txt.split(/[, \n]+/).map(s => s.trim()).filter(Boolean);
        const idsFrom = (arr) => arr.map(tok => {
          const m = tok.match(/^<@!?(\d+)>$/); // mention
          if (m) return m[1];
          // if plain number, take it
          if (/^\d{5,}$/.test(tok)) return tok;
          // try to find by display name in pool (best-effort)
          for (const [uid, info] of war.pool.entries()) {
            if (info.name.toLowerCase() === tok.toLowerCase()) return uid;
          }
          return null;
        }).filter(Boolean);

        const startersIds = idsFrom(parseList(startersText));
        const backupsIds  = idsFrom(parseList(backupsText));

        if (startersIds.length !== war.teamSize) {
          return interaction.reply({ ephemeral: true, content: `Please provide exactly ${war.teamSize} starters.` });
        }

        // Mark roster
        war.starters = startersIds;
        war.backups = backupsIds.filter(id => !startersIds.includes(id));
        war.locked = true;

        // DM confirmations
        const guild = interaction.guild;
        for (const uid of war.starters) {
          guild.members.fetch(uid).then(m => m.send(`✅ You are a **starter** for War #${war.id} vs **${war.opponent}** at ${war.startET} ET.`)).catch(() => {});
        }
        for (const uid of war.backups) {
          guild.members.fetch(uid).then(m => m.send(`ℹ️ You are a **backup** for War #${war.id} vs **${war.opponent}** at ${war.startET} ET.`)).catch(() => {});
        }

        // Persist (best-effort)
        const message = await guild.channels.cache.get(war.channelId).messages.fetch(war.messageId);
        try {
          recordLockedWar?.({
            warId: war.id,
            messageId: war.messageId,
            opponent: war.opponent,
            format: war.format.toUpperCase(),
            startET: war.startET,
            starters: war.starters.map(u => ({ userId: u, name: war.pool.get(u)?.name || u })),
            backups: war.backups.map(u => ({ userId: u, name: war.pool.get(u)?.name || u })),
          });
        } catch {}
        try {
          await pushWarLock({
            warId: war.id,
            opponent: war.opponent,
            format: war.format.toUpperCase(),
            startET: war.startET,
            lockedAt: new Date().toISOString(),
            teamSize: war.teamSize,
            starters: war.starters.map(u => ({ userId: u, name: war.pool.get(u)?.name || u })),
            backups: war.backups.map(u => ({ userId: u, name: war.pool.get(u)?.name || u })),
            plannedMaps: war.mapsPlanned || [],
          });
        } catch (e) { console.error('Sheets pushWarLock failed:', e.message); }

        await updateSignupEmbed(message);
        return interaction.reply({ ephemeral: true, content: `✅ Roster set for War #${war.id}.` });
      }

      // End War summary (VOD + Notes/Subs)
      if (interaction.customId.startsWith('war:end:modal:')) {
        const [, , , warMsgId] = interaction.customId.split(':');
        const war = wars.get(warMsgId);
        if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });

        const vod = interaction.fields.getTextInputValue('war:vod')?.trim();
        const notes = interaction.fields.getTextInputValue('war:notes')?.trim();
        const subs = interaction.fields.getTextInputValue('war:subs')?.trim();

        if (vod) {
          try { setVOD?.({ warId: war.id, url: vod }); } catch {}
          try { await pushVOD({ warId: war.id, vodUrl: vod }); } catch (e) { console.error('Sheets VOD push failed:', e.message); }
        }
        if (subs) {
          // parse lines like "IN -> OUT (note)"
          const lines = subs.split('\n').map(s => s.trim()).filter(Boolean);
          for (const line of lines) {
            const m = line.match(/^(.+?)\s*->\s*(.+?)(?:\s*\((.+)\))?$/);
            const userIn = m?.[1]?.trim() || '';
            const userOut = m?.[2]?.trim() || '';
            const note = m?.[3]?.trim() || '';
            try { addSub?.({ warId: war.id, userIn, userOut, note }); } catch {}
            try { await pushSub({ warId: war.id, userIn, userOut, note }); } catch (e) { console.error('Sheets sub push failed:', e.message); }
          }
        }

        // Post public result summary
        const guild = interaction.guild;
        const resultsChannelId = process.env.RESULTS_CHANNEL_ID || war.channelId;
        const resultsCh = guild.channels.cache.get(resultsChannelId) || interaction.channel;

        // Compute series score from maps in DB/Sessions if available
        let maps = [];
        try { maps = getMaps?.(war.id) || []; } catch {}
        // Fallback to planned (no scores) if DB not present
        const lines = [];
        let ourSeries = 0, oppSeries = 0;
        for (const [i, m] of maps.entries()) {
          const our = Number(m.our_score ?? m.our ?? 0);
          const opp = Number(m.opp_score ?? m.opp ?? 0);
          if (Number.isFinite(our) && Number.isFinite(opp)) {
            if (our > opp) ourSeries++; else if (opp > our) oppSeries++;
            lines.push(`Map ${m.map_order || i + 1}: ${m.map_name} — **${our}–${opp}**`);
          }
        }
        const finalLine = (ourSeries + oppSeries) > 0 ? `**Final:** ${ourSeries}–${oppSeries}` : 'Final: (no scored maps logged)';

        await resultsCh.send({
          content: process.env.ADMIN_PING_ROLE_ID ? `<@&${process.env.ADMIN_PING_ROLE_ID}>` : undefined,
          embeds: [
            new EmbedBuilder()
              .setTitle(`War #${war.id} vs ${war.opponent}`)
              .setDescription([`Format: ${war.format.toUpperCase()} — ${war.teamSize}v${war.teamSize}`, `Start: ${war.startET} ET`, '', ...lines, '', finalLine, vod ? `\nVOD: ${vod}` : ''].join('\n'))
              .setColor(0x3498db),
          ],
        });

        return interaction.reply({ ephemeral: true, content: '✅ War results posted.' });
      }
    }

    /* ---------- BUTTONS & SELECTS ---------- */
    if (interaction.isButton()) {
      const id = interaction.customId;

      // Full tutorial DM
      if (id === 'help:full') {
        const longText = [
          '📖 **WarBot Full Tutorial**',
          '',
          '**For All Users**',
          '1) React 👍 to sign up. Unreact to drop out anytime.',
          '2) You’ll be DM’d if you are a starter or a backup.',
          '',
          '**For Admins & War Managers**',
          '• `/warbot new` → team size → format → opponent → pick start time.',
          '• `/warbot select id:<#>` → choose starters (or Auto-pick) → **Set Maps** (last is Crossroads/Crossroads Night) → **Choose Roster**.',
          '• **Unlock Roster** to re-pick if someone drops (bot pings you automatically).',
          '• **End War** → for each map log map, side (SEALs/Terrorists), and scores 0–6 → optional VOD/notes/subs.',
          '• Results auto-post in #warbot (and results channel if configured) + sync to Google Sheets.',
          '',
          '**For Keepers**',
          '• Can log scores, substitutions, no-shows and set VOD.',
          '• Buttons: **Add Map Result**, **End War**.',
          '',
          '**For Captains**',
          '• Can **End War** and log results; can cancel with 🛑 if needed.',
          '',
          '**Cancel a War**',
          '• React 🛑 on the sign-up post (Admins/Managers/Keepers/Captains only). The post is removed and a cancellation notice is sent.',
        ].join('\n');

        try {
          await interaction.user.send(longText);
          return interaction.reply({ ephemeral: true, content: '📬 Sent you the full tutorial in DMs.' });
        } catch {
          return interaction.reply({ ephemeral: true, content: '❌ Could not DM you (your DMs may be closed).' });
        }
      }

      // Pagination for time select
      if (id.startsWith('new:timepage:')) {
        const [, , pageStr, sizeStr, fmt, oppEnc] = id.split(':');
        const page = parseInt(pageStr, 10);
        const sizeNum = Number(sizeStr);
        const opp = decodeURIComponent(oppEnc);

        const now = new Date();
        now.setMinutes(now.getMinutes() - (now.getMinutes() % 30), 0, 0);
        const slots = 72 * 2;
        const allOptions = [];
        for (let i = 0; i < slots; i++) {
          const d = new Date(now.getTime() + i * 30 * 60 * 1000);
          const et = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true, month: 'short', day: '2-digit' });
          allOptions.push({ label: et, value: d.toISOString() });
        }
        const perPage = 25;
        const totalPages = Math.ceil(allOptions.length / perPage);
        const clamped = Math.max(0, Math.min(page, totalPages - 1));
        const pageOptions = allOptions.slice(clamped * perPage, clamped * perPage + perPage);

        const select = new StringSelectMenuBuilder()
          .setCustomId(`new:time:${sizeNum}:${fmt}:${encodeURIComponent(opp)}`)
          .setPlaceholder(`Select start time (page ${clamped + 1}/${totalPages})`)
          .setMinValues(1).setMaxValues(1)
          .addOptions(pageOptions);

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`new:timepage:${Math.max(clamped - 1, 0)}:${sizeNum}:${fmt}:${encodeURIComponent(opp)}`)
            .setLabel('Prev Page')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(clamped === 0),
          new ButtonBuilder()
            .setCustomId(`new:timepage:${Math.min(clamped + 1, totalPages - 1)}:${sizeNum}:${fmt}:${encodeURIComponent(opp)}`)
            .setLabel('Next Page')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(clamped >= totalPages - 1)
        );

        return interaction.update({ components: [new ActionRowBuilder().addComponents(select), buttons] });
      }

      // Auto-pick first N
      if (id.startsWith('roster:auto:')) {
        const warMsgId = id.split(':')[2];
        const war = wars.get(warMsgId);
        if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });
        if (!isAdminish(interaction.member)) return interaction.reply({ ephemeral: true, content: 'No permission.' });

        const sorted = poolArray(war);
        const starters = sorted.slice(0, war.teamSize).map(p => p.userId);
        const backups = sorted.slice(war.teamSize).map(p => p.userId);

        war.starters = starters;
        war.backups = backups;
        war.locked = true;

        const guild = interaction.guild;
        for (const uid of war.starters) guild.members.fetch(uid).then(m => m.send(`✅ You are a **starter** for War #${war.id} vs **${war.opponent}** at ${war.startET} ET.`)).catch(()=>{});
        for (const uid of war.backups) guild.members.fetch(uid).then(m => m.send(`ℹ️ You are a **backup** for War #${war.id} vs **${war.opponent}** at ${war.startET} ET.`)).catch(()=>{});

        // Persist + Sheets
        const message = await guild.channels.cache.get(war.channelId).messages.fetch(war.messageId);
        try {
          recordLockedWar?.({
            warId: war.id,
            messageId: war.messageId,
            opponent: war.opponent,
            format: war.format.toUpperCase(),
            startET: war.startET,
            starters: war.starters.map(u => ({ userId: u, name: war.pool.get(u)?.name || u })),
            backups: war.backups.map(u => ({ userId: u, name: war.pool.get(u)?.name || u })),
          });
        } catch {}
        try {
          await pushWarLock({
            warId: war.id,
            opponent: war.opponent,
            format: war.format.toUpperCase(),
            startET: war.startET,
            lockedAt: new Date().toISOString(),
            teamSize: war.teamSize,
            starters: war.starters.map(u => ({ userId: u, name: war.pool.get(u)?.name || u })),
            backups: war.backups.map(u => ({ userId: u, name: war.pool.get(u)?.name || u })),
            plannedMaps: war.mapsPlanned || [],
          });
        } catch (e) { console.error('Sheets pushWarLock failed:', e.message); }

        await updateSignupEmbed(message);
        return interaction.reply({ ephemeral: true, content: `✅ Auto-picked ${war.teamSize}. Starters & backups DM’d.` });
      }

      // Choose roster (opens modal)
      if (id.startsWith('roster:choose:')) {
        const warMsgId = id.split(':')[2];
        const war = wars.get(warMsgId);
        if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });
        if (!isAdminish(interaction.member)) return interaction.reply({ ephemeral: true, content: 'No permission.' });

        const modal = new ModalBuilder()
          .setCustomId(`roster:choose:modal:${warMsgId}`)
          .setTitle(`Choose Roster (War #${war.id})`);

        const starters = new TextInputBuilder()
          .setCustomId('roster:starters')
          .setLabel(`Enter exactly ${war.teamSize} starters (mentions or IDs, comma/space separated)`)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        const backups = new TextInputBuilder()
          .setCustomId('roster:backups')
          .setLabel('Optional backups (mentions or IDs)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        modal.addComponents(new ActionRowBuilder().addComponents(starters), new ActionRowBuilder().addComponents(backups));
        return interaction.showModal(modal);
      }

      // Unlock roster
      if (id.startsWith('roster:unlock:')) {
        const warMsgId = id.split(':')[2];
        const war = wars.get(warMsgId);
        if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });
        if (!isAdminish(interaction.member)) return interaction.reply({ ephemeral: true, content: 'No permission.' });

        war.locked = false;
        const msg = await interaction.channel.messages.fetch(warMsgId);
        await updateSignupEmbed(msg);
        return interaction.reply({ ephemeral: true, content: '🔓 Roster unlocked. You can re-select now.' });
      }

      // Set maps (step-through dropdowns)
      if (id.startsWith('maps:set:')) {
        const warMsgId = id.split(':')[2];
        const war = wars.get(warMsgId);
        if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });
        if (!isAdminish(interaction.member)) return interaction.reply({ ephemeral: true, content: 'No permission.' });

        const needed = war.format === 'bo3' ? 3 : 5;
        mapPlanProgress.set(`${interaction.user.id}:${warMsgId}`, { warMsgId, needed, stepIndex: 0, picks: [] });

        // First select
        const choices = SOCOM_MAPS.filter(m => m !== 'Crossroads - Demolition' && m !== 'Crossroads Night - Demolition');
        const select = new StringSelectMenuBuilder()
          .setCustomId(`maps:pick:${warMsgId}`)
          .setPlaceholder(`Pick Map 1 of ${needed}`)
          .setMinValues(1).setMaxValues(1)
          .addOptions(choices.slice(0, 25).map(m => ({ label: m, value: m })));

        return interaction.reply({ ephemeral: true, content: 'Pick the maps in order (last will be Crossroads/Crossroads Night).', components: [new ActionRowBuilder().addComponents(select)] });
      }

      // Add Map Result (one map at a time)
      if (id.startsWith('maps:add:')) {
        const warMsgId = id.split(':')[2];
        const war = wars.get(warMsgId);
        if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });
        if (!isAdminish(interaction.member)) return interaction.reply({ ephemeral: true, content: 'No permission.' });

        // Step 1: choose map via dropdown
        addMapSession.set(`${interaction.user.id}:${warMsgId}`, { warMsgId });
        const select = new StringSelectMenuBuilder()
          .setCustomId(`maps:add:choose:${warMsgId}`)
          .setPlaceholder('Select the map played')
          .setMinValues(1).setMaxValues(1)
          .addOptions(SOCOM_MAPS.slice(0, 25).map(m => ({ label: m, value: m })));

        return interaction.reply({ ephemeral: true, content: 'Choose a map to record a score for.', components: [new ActionRowBuilder().addComponents(select)] });
      }

      // End War (VOD, Notes, Subs)
      if (id.startsWith('war:end:')) {
        const warMsgId = id.split(':')[2];
        const war = wars.get(warMsgId);
        if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });
        if (!isAdminish(interaction.member)) return interaction.reply({ ephemeral: true, content: 'No permission.' });

        const modal = new ModalBuilder().setCustomId(`war:end:modal:${warMsgId}`).setTitle(`End War #${war.id}`);

        const vod = new TextInputBuilder()
          .setCustomId('war:vod')
          .setLabel('VOD link (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const notes = new TextInputBuilder()
          .setCustomId('war:notes')
          .setLabel('Notes (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        const subs = new TextInputBuilder()
          .setCustomId('war:subs')
          .setLabel('Substitutions (one per line: IN -> OUT (note))')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(vod),
          new ActionRowBuilder().addComponents(notes),
          new ActionRowBuilder().addComponents(subs),
        );

        return interaction.showModal(modal);
      }
    }

    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;

      // Time chosen -> create sign-up post
      if (id.startsWith('new:time:')) {
        const [, , sizeStr, fmt, oppEnc] = id.split(':');
        const sizeNum = Number(sizeStr);
        const opp = decodeURIComponent(oppEnc);
        const iso = interaction.values[0];

        const startET = etString(iso);
        const warChannelId = process.env.WAR_CHANNEL_ID || interaction.channelId;
        const warChannel = interaction.guild.channels.cache.get(warChannelId) || interaction.channel;

        const embed = new EmbedBuilder()
          .setTitle('War Sign-up')
          .setColor(0x2ecc71)
          .setDescription(
            [
              `**Opponent:** ${opp}`,
              `**Format:** ${fmt.toUpperCase()}`,
              `**Start (ET):** ${startET}`,
              '',
              `React 👍 to join the pool. Unreact to drop out.`,
              `Admins can unlock/re-pick if someone drops.`,
            ].join('\n')
          )
          .setFooter({ text: `Team size: ${sizeNum}v${sizeNum}` });

        const message = await warChannel.send({
          content: process.env.RECRUIT_PING_ROLE_ID ? `<@&${process.env.RECRUIT_PING_ROLE_ID}>` : undefined,
          embeds: [embed],
        });

        // Track war state
        const warObj = {
          id: nextWarId++,
          messageId: message.id,
          channelId: message.channelId,
          opponent: opp,
          format: fmt,
          teamSize: sizeNum,
          startISO: iso,
          startET,
          pool: new Map(),
          starters: [],
          backups: [],
          mapsPlanned: [],
          locked: false,
        };
        wars.set(message.id, warObj);

        // Controls
        await updateSignupEmbed(message);

        // Add stop-sign & listen for 👍
        try { await message.react('🛑'); } catch {}
        try { await message.react('👍'); } catch {}

        return interaction.reply({ ephemeral: true, content: `✅ War Sign-up #${warObj.id} created in <#${warChannel.id}>.` });
      }

      // Maps set, step-through
      if (id.startsWith('maps:pick:')) {
        const warMsgId = id.split(':')[2];
        const war = wars.get(warMsgId);
        if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });

        const key = `${interaction.user.id}:${warMsgId}`;
        const prog = mapPlanProgress.get(key);
        if (!prog) return interaction.reply({ ephemeral: true, content: 'Map planning not in progress.' });

        const pick = interaction.values[0];
        prog.picks.push(pick);
        prog.stepIndex++;

        const needed = prog.needed;
        // If we still need picks before the last map
        if (prog.stepIndex < needed - 1) {
          // next selection (still any map except forcing last)
          const remainChoices = SOCOM_MAPS.filter(m => !LAST_MAP_CHOICES.includes(m));
          const select = new StringSelectMenuBuilder()
            .setCustomId(`maps:pick:${warMsgId}`)
            .setPlaceholder(`Pick Map ${prog.stepIndex + 1} of ${needed}`)
            .setMinValues(1).setMaxValues(1)
            .addOptions(remainChoices.slice(0, 25).map(m => ({ label: m, value: m })));

          return interaction.update({ components: [new ActionRowBuilder().addComponents(select)] });
        }

        // Last map must be Crossroads/Crossroads Night
        if (prog.stepIndex === needed - 1) {
          const selectLast = new StringSelectMenuBuilder()
            .setCustomId(`maps:picklast:${warMsgId}`)
            .setPlaceholder(`Pick LAST map (${needed} of ${needed})`)
            .setMinValues(1).setMaxValues(1)
            .addOptions(LAST_MAP_CHOICES.map(m => ({ label: m, value: m })));

          return interaction.update({ components: [new ActionRowBuilder().addComponents(selectLast)] });
        }

        return; // safety
      }

      if (id.startsWith('maps:picklast:')) {
        const warMsgId = id.split(':')[2];
        const war = wars.get(warMsgId);
        if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });

        const key = `${interaction.user.id}:${warMsgId}`;
        const prog = mapPlanProgress.get(key);
        if (!prog) return interaction.reply({ ephemeral: true, content: 'Map planning not in progress.' });

        const lastPick = interaction.values[0];
        prog.picks.push(lastPick);

        // Save to war & persist draft (no scores)
        war.mapsPlanned = prog.picks.slice();
        try { addMapsDraft?.({ warId: war.id, mapNames: war.mapsPlanned }); } catch {}
        // Sheets: push rows with no score (side blank)
        try {
          let order = 1;
          for (const name of war.mapsPlanned) {
            await pushAddedMap({ warId: war.id, mapOrder: order++, mapName: name, our: '', opp: '', side: '' });
          }
        } catch (e) { console.error('Sheets pushAddedMap failed:', e.message); }

        mapPlanProgress.delete(key);

        const message = await interaction.channel.messages.fetch(warMsgId);
        await updateSignupEmbed(message);
        return interaction.update({ content: '✅ Maps set.', components: [] });
      }

      // Add Map Result: pick map name
      if (id.startsWith('maps:add:choose:')) {
        const warMsgId = id.split(':')[3];
        const war = wars.get(warMsgId);
        if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });

        const chosen = interaction.values[0];
        const sessKey = `${interaction.user.id}:${warMsgId}`;
        addMapSession.set(sessKey, { warMsgId, mapName: chosen });

        // Now ask for scores + side via modal
        const modal = new ModalBuilder()
          .setCustomId(`maps:add:modal:${warMsgId}`)
          .setTitle(`Record Map — ${chosen}`);

        const our = new TextInputBuilder().setCustomId('maps:add:our').setLabel('Our score (0-6)').setStyle(TextInputStyle.Short).setRequired(true);
        const opp = new TextInputBuilder().setCustomId('maps:add:opp').setLabel('Opp score (0-6)').setStyle(TextInputStyle.Short).setRequired(true);
        // Put side in a short text (SEALs or Terrorists)
        const side = new TextInputBuilder().setCustomId('maps:add:side').setLabel('Our side (SEALs/Terrorists)').setStyle(TextInputStyle.Short).setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(our),
          new ActionRowBuilder().addComponents(opp),
          new ActionRowBuilder().addComponents(side),
        );

        await interaction.update({ components: [] });
        return interaction.showModal(modal);
      }
    }

    // Modal for Add Map Result
    if (interaction.isModalSubmit() && interaction.customId.startsWith('maps:add:modal:')) {
      const warMsgId = interaction.customId.split(':')[3];
      const war = wars.get(warMsgId);
      if (!war) return interaction.reply({ ephemeral: true, content: 'War not found.' });

      const sessKey = `${interaction.user.id}:${warMsgId}`;
      const sess = addMapSession.get(sessKey);
      if (!sess) return interaction.reply({ ephemeral: true, content: 'Session expired. Click "Add Map Result" again.' });

      const mapName = sess.mapName;
      const our = Number(interaction.fields.getTextInputValue('maps:add:our').trim());
      const opp = Number(interaction.fields.getTextInputValue('maps:add:opp').trim());
      const side = interaction.fields.getTextInputValue('maps:add:side').trim();

      if (!Number.isInteger(our) || our < 0 || our > 6) return interaction.reply({ ephemeral: true, content: 'Our score must be 0–6.' });
      if (!Number.isInteger(opp) || opp < 0 || opp > 6) return interaction.reply({ ephemeral: true, content: 'Opp score must be 0–6.' });
      if (!['seals', 'terrorists'].includes(side.toLowerCase())) return interaction.reply({ ephemeral: true, content: 'Side must be SEALs or Terrorists.' });

      // Determine map order (append)
      let order = 1;
      try {
        const existing = getMaps?.(war.id) || [];
        order = (existing.length ? Math.max(...existing.map(m => Number(m.map_order || m.mapOrder || 0))) + 1 : 1);
      } catch {}

      // Persist DB + Sheets
      try { updateMapScore?.({ warId: war.id, mapOrder: order, our, opp, mapName }); } catch {}
      try { await pushMapScore({ warId: war.id, mapOrder: order, mapName, our, opp, side: side.toUpperCase() }); } catch (e) { console.error('Sheets pushMapScore failed:', e.message); }

      addMapSession.delete(sessKey);
      return interaction.reply({ ephemeral: true, content: `✅ Logged ${mapName}: ${our}-${opp} (${side.toUpperCase()}).` });
    }
  } catch (err) {
    console.error('Error handling interaction:', err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ ephemeral: true, content: 'Something went wrong.' }); } catch {}
    }
  }
});

/* ----------------------- REACTIONS (👍 pool, 🛑 cancel) ----------------------- */

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

    const war = wars.get(message.id);
    if (!war) return;

    const emoji = reaction.emoji?.name;
    const guild = message.guild;

    if (emoji === '🛑') {
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!isAdminish(member)) return;
      try {
        await message.delete();
        await message.channel.send({ content: '🛑 War sign-up **cancelled** by staff. (Message removed.)' });
        wars.delete(message.id);
      } catch (e) { console.error('Cancel delete error:', e); }
      return;
    }

    if (emoji === '👍') {
      if (!war.pool.has(user.id)) {
        war.pool.set(user.id, { name: (await guild.members.fetch(user.id)).displayName, joinedISO: new Date().toISOString() });
      }
      await updateSignupEmbed(message);

      // Ping admin when pool reaches teamSize
      if (war.pool.size >= war.teamSize && !war.locked) {
        if (process.env.ADMIN_PING_ROLE_ID) {
          await message.channel.send({ content: `<@&${process.env.ADMIN_PING_ROLE_ID}> ${war.teamSize}+ signed up for War #${war.id}.` });
        }
      }
    }
  } catch (e) { console.error('messageReactionAdd error:', e); }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

    const war = wars.get(message.id);
    if (!war) return;

    const emoji = reaction.emoji?.name;
    if (emoji === '👍') {
      war.pool.delete(user.id);

      // If a starter dropped, ping admins to re-select
      if (war.starters.includes(user.id)) {
        war.starters = war.starters.filter(id => id !== user.id);
        if (process.env.ADMIN_PING_ROLE_ID) {
          await message.channel.send({ content: `<@&${process.env.ADMIN_PING_ROLE_ID}> A starter dropped from War #${war.id}. Please re-select.` });
        }
      }

      // If no backups left, ping recruit role to refill
      if (war.backups.length === 0 && process.env.RECRUIT_PING_ROLE_ID) {
        await message.channel.send({ content: `<@&${process.env.RECRUIT_PING_ROLE_ID}> Backups needed for War #${war.id}. React 👍 to join.` });
      }

      await updateSignupEmbed(message);
    }
  } catch (e) { console.error('messageReactionRemove error:', e); }
});

/* ----------------------- LOGIN ----------------------- */

client.login(process.env.DISCORD_TOKEN);

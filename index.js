// index.js — Two-step wizard to avoid timeouts & simplify UX
// Step A: /warbot new -> showModal (initial response)
// Step B: ephemeral reply with Date/Time dropdowns -> Create Sign-up
// Also supports /warbot cancel war_id, 👍 join, 👎 opt-out, 🛑 cancel
// Requires env: DISCORD_TOKEN, CLIENT_ID, GUILD_ID, WAR_CHANNEL_ID (+ your Sheets env)

process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION:', e));
process.on('uncaughtException', (e) => console.error('UNCAUGHT EXCEPTION:', e));

import 'dotenv/config';
import http from 'http';
import {
  Client, GatewayIntentBits, Partials,
  REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { initSheets, getNextWarId, pushWarCreated, pushResponse } from './sheets.js';
import { initDB } from './db.js';

/* -------- Optional health server (Render Web Service compatible) -------- */
const RENDER_PORT = Number(process.env.PORT);
if (Number.isFinite(RENDER_PORT) && RENDER_PORT > 0) {
  http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WarBot OK\n');
  }).listen(RENDER_PORT, '0.0.0.0', () => console.log(`🌐 Health server :${RENDER_PORT}`));
} else {
  console.log('ℹ️ No PORT provided; skipping HTTP listener (OK for Background Worker).');
}

/* ---------------- In-memory state ---------------- */
/** wizard[userId] = { warId, opponent, teamSize, format, dateISO, dateLabel, timeValue, timeLabel, startET } */
const wizard = new Map();
/** pools[msgId] = { warId, signups: Map<userId,{name,tsMs}>, declines: Map<userId,{name,tsMs}> } */
const pools = new Map();
/** warId -> messageId */
const warToMessage = new Map();

/* ---------------- Helpers ---------------- */
function embedWithWarId(base, warId) {
  const id = String(warId);
  const title = `War Sign-up #${id}`;
  const desc = base.description?.includes('**War ID:**')
    ? base.description
    : `**War ID:** ${id}\n${base.description ?? ''}`;
  return { ...base, title, description: desc, footer: { text: `War #${id}` } };
}

function etAddDays(days) {
  const now = new Date();
  const d = new Date(now.getTime() + days * 86400000);
  d.setUTCHours(16, 0, 0, 0); // anchor
  return d;
}
function etDateLabel(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}
function etYYYYMMDD(d) {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/New_York' }).format(d);
}
function buildDateChoices7() {
  const opts = [];
  for (let i = 0; i < 7; i++) {
    const d = etAddDays(i);
    opts.push({ label: etDateLabel(d), value: etYYYYMMDD(d) });
  }
  return opts;
}
function buildTimeChoicesEvening() {
  const times = [];
  let h = 16, m = 30; // 4:30 PM
  while (h < 23 || (h === 23 && m <= 30)) {
    const label = new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
    });
    const val = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    times.push({ label, value: val });
    m += 30;
    if (m >= 60) { m = 0; h += 1; }
  }
  times.push({ label: 'Other…', value: 'other' });
  return times;
}

function dateMenu(selectedValue) {
  const opts = buildDateChoices7().map(o => ({ ...o, default: selectedValue === o.value }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:date')
      .setPlaceholder('Pick date (ET) — next 7 days')
      .addOptions(...opts)
  );
}
function timeMenu(selectedValue) {
  const opts = buildTimeChoicesEvening().map(o => ({ ...o, default: selectedValue === o.value }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:time')
      .setPlaceholder('Pick time (ET) — 4:30 PM to 11:30 PM')
      .addOptions(...opts)
  );
}
function createButtons(enabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wb:create').setLabel('Create Sign-up').setStyle(ButtonStyle.Success).setDisabled(!enabled),
    new ButtonBuilder().setCustomId('wb:cancelwiz').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}
function miniSummary(st) {
  return `Opponent: **${st.opponent || '—'}** | Team: **${st.teamSize || '—'}v${st.teamSize || '—'}** | Format: **${st.format || '—'}**\n` +
         `Date: **${st.dateLabel || '—'}** | Time: **${st.timeLabel || '—'}**`;
}
function formatLines(map) {
  const list = [...map.values()].sort((a,b) => a.tsMs - b.tsMs);
  if (!list.length) return '_none yet_';
  return list.map(v => {
    const dt = new Date(v.tsMs).toLocaleString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      month: 'numeric', day: 'numeric', timeZone: 'America/New_York'
    });
    return `${v.name} (${dt} ET)`;
  }).join('\n');
}

/* ---------------- Commands ---------------- */
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName('warbot')
      .setDescription('WarBot controls')
      .addSubcommand(s => s.setName('new').setDescription('Create a War Sign-up (wizard)'))
      .addSubcommand(s => s.setName('cancel').setDescription('Cancel a War Sign-up by War ID')
        .addIntegerOption(o => o.setName('war_id').setDescription('War ID to cancel').setRequired(true)))
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: cmds }
  );
  console.log('✅ Registered /warbot commands');
}

/* ---------------- Client ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

/* ---------------- Interaction flow ---------------- */
client.on('interactionCreate', async (interaction) => {
  try {
    /* ---- /warbot new -> show modal immediately (initial response) ---- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'warbot' && interaction.options.getSubcommand() === 'new') {
      const modal = new ModalBuilder().setCustomId('wb:new:modal').setTitle('New War — Step A');

      const opp = new TextInputBuilder()
        .setCustomId('opp').setLabel('Opponent').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50);

      const size = new TextInputBuilder()
        .setCustomId('size').setLabel('Team Size (6 / 7 / 8)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2);

      const fmt = new TextInputBuilder()
        .setCustomId('fmt').setLabel('Format (BO3 / BO5)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3);

      modal.addComponents(
        new ActionRowBuilder().addComponents(opp),
        new ActionRowBuilder().addComponents(size),
        new ActionRowBuilder().addComponents(fmt),
      );
      await interaction.showModal(modal);
      return;
    }

    /* ---- /warbot cancel ---- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'warbot' && interaction.options.getSubcommand() === 'cancel') {
      await interaction.reply({ content: '⏳ Cancelling…', flags: 1 << 6 });
      const warId = interaction.options.getInteger('war_id', true);
      const msgId = warToMessage.get(String(warId));
      if (!msgId) {
        await interaction.editReply(`❌ I can’t find an active sign-up for War ID ${warId}.`);
        return;
      }
      const ch = await client.channels.fetch(process.env.WAR_CHANNEL_ID).catch(()=>null);
      const msg = ch ? await ch.messages.fetch(msgId).catch(()=>null) : null;
      if (msg) await msg.delete().catch(()=>{});
      warToMessage.delete(String(warId));
      pools.delete(msgId);
      await interaction.editReply(`🛑 War Sign-up #${warId} cancelled and message removed.`);
      return;
    }

    /* ---- Modal submit: Step A done -> show Step B (ephemeral) ---- */
    if (interaction.isModalSubmit() && interaction.customId === 'wb:new:modal') {
      // Validate inputs
      const opponent = interaction.fields.getTextInputValue('opp').trim();
      let size = interaction.fields.getTextInputValue('size').trim();
      let fmt  = interaction.fields.getTextInputValue('fmt').trim().toUpperCase();

      size = size.replace(/[^\d]/g, '');
      if (!['6','7','8'].includes(size)) {
        await interaction.reply({ content: '❌ Team size must be 6, 7, or 8.', flags: 1<<6 });
        return;
      }
      if (!['BO3','BO5'].includes(fmt)) {
        await interaction.reply({ content: '❌ Format must be BO3 or BO5.', flags: 1<<6 });
        return;
      }

      // Compute War ID now
      let warId;
      try { warId = await getNextWarId(); }
      catch { warId = null; }
      if (!Number.isInteger(warId)) {
        const n = new Date();
        warId = Number(`${n.getUTCFullYear()}${String(n.getUTCMonth()+1).padStart(2,'0')}${String(n.getUTCDate()).padStart(2,'0')}${String(n.getUTCHours()).padStart(2,'0')}${String(n.getUTCMinutes()).padStart(2,'0')}`);
      }

      wizard.set(interaction.user.id, {
        warId, opponent, teamSize: size, format: fmt,
        dateISO: null, dateLabel: null, timeValue: null, timeLabel: null, startET: null
      });

      await interaction.reply({
        content:
          `🧭 **War Wizard (Step B)** — **War ID ${warId}**\n` +
          `${miniSummary(wizard.get(interaction.user.id))}\n\n` +
          `Pick **Date** and **Time (ET)**, then press **Create Sign-up**.`,
        components: [dateMenu(null), timeMenu(null), createButtons(false)],
        flags: 1 << 6, // ephemeral
      });
      return;
    }

    /* ---- Step B: selects & buttons ---- */
    if (interaction.isStringSelectMenu()) {
      const st = wizard.get(interaction.user.id);
      if (!st) return;

      if (interaction.customId === 'wb:date') {
        await interaction.deferUpdate();
        st.dateISO = interaction.values[0];
        st.dateLabel = buildDateChoices7().find(o => o.value === st.dateISO)?.label || st.dateISO;
        if (st.timeLabel) st.startET = `${st.dateLabel}, ${st.timeLabel} ET`;
        const ready = !!(st.dateLabel && (st.timeLabel || st.timeValue));
        await interaction.editReply({
          content:
            `🧭 **War Wizard (Step B)** — **War ID ${st.warId}**\n` +
            `${miniSummary(st)}\n\nPick **Date** and **Time (ET)**, then press **Create Sign-up**.`,
          components: [dateMenu(st.dateISO), timeMenu(st.timeValue), createButtons(ready)],
        });
        return;
      }

      if (interaction.customId === 'wb:time') {
        // "Other…" => open modal (no deferUpdate before showModal)
        if (interaction.values[0] === 'other') {
          const modal = new ModalBuilder().setCustomId('wb:time:other').setTitle('Custom Time (ET)');
          const txt = new TextInputBuilder()
            .setCustomId('othertime').setLabel('Enter time in ET (e.g., "1:05 AM" or "13:05")')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40);
          modal.addComponents(new ActionRowBuilder().addComponents(txt));
          await interaction.showModal(modal);
          return;
        }

        await interaction.deferUpdate();
        const val = interaction.values[0];
        st.timeValue = val;
        const [H,M] = val.split(':').map(n => parseInt(n, 10));
        st.timeLabel = new Date(Date.UTC(2000,0,1,H,M)).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
        });
        if (st.dateLabel) st.startET = `${st.dateLabel}, ${st.timeLabel} ET`;
        const ready = !!(st.dateLabel && (st.timeLabel || st.timeValue));
        await interaction.editReply({
          content:
            `🧭 **War Wizard (Step B)** — **War ID ${st.warId}**\n` +
            `${miniSummary(st)}\n\nPress **Create Sign-up** when ready.`,
          components: [dateMenu(st.dateISO), timeMenu(st.timeValue), createButtons(ready)],
        });
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === 'wb:time:other') {
      const st = wizard.get(interaction.user.id);
      if (!st) return;
      const txt = interaction.fields.getTextInputValue('othertime').trim();
      st.timeValue = null;
      st.timeLabel = txt;
      if (st.dateLabel) st.startET = `${st.dateLabel}, ${st.timeLabel} ET`;
      const ready = !!(st.dateLabel && (st.timeLabel || st.timeValue));
      await interaction.reply({
        content:
          `🧭 **War Wizard (Step B)** — **War ID ${st.warId}**\n` +
          `${miniSummary(st)}\n\nPress **Create Sign-up** when ready.`,
        components: [dateMenu(st.dateISO), timeMenu(null), createButtons(ready)],
        flags: 1 << 6,
      });
      return;
    }

    if (interaction.isButton()) {
      const st = wizard.get(interaction.user.id);

      if (interaction.customId === 'wb:cancelwiz') {
        await interaction.deferUpdate();
        wizard.delete(interaction.user.id);
        await interaction.editReply({ content: '❌ Wizard cancelled.', components: [] });
        return;
      }

      if (interaction.customId === 'wb:create') {
        await interaction.deferUpdate();
        if (!st || !st.opponent || !st.teamSize || !st.format || !st.dateLabel || !(st.timeLabel || st.timeValue)) {
          await interaction.editReply({ content: '❌ Missing info. Please complete all fields.', components: [] });
          return;
        }

        const chId = process.env.WAR_CHANNEL_ID;
        const ch = chId ? await client.channels.fetch(chId).catch(()=>null) : null;
        if (!ch || !ch.isTextBased()) {
          await interaction.editReply('❌ WAR_CHANNEL_ID is missing or invalid.');
          return;
        }

        const startText = st.startET || `${st.dateLabel}, ${st.timeLabel} ET`;

        let embed = {
          title: `War Sign-up #${st.warId}`,
          description:
            `**War ID:** ${st.warId}\n` +
            `**Opponent:** ${st.opponent}\n` +
            `**Format:** ${st.format}\n` +
            `**Team Size:** ${st.teamSize}v${st.teamSize}\n` +
            `**Start (ET):** ${startText}\n\n` +
            `React 👍 to **join** (timestamp recorded).\nReact 👎 if you **cannot** play.\nReact 🛑 to **cancel** this sign-up.`,
          footer: { text: `War #${st.warId}` }
        };
        embed = embedWithWarId(embed, st.warId);

        const msg = await ch.send({ embeds: [embed] });
        warToMessage.set(String(st.warId), msg.id);
        pools.set(msg.id, { warId: st.warId, signups: new Map(), declines: new Map() });

        // Log to Sheets
        pushWarCreated({
          warId: st.warId,
          opponent: st.opponent,
          format: st.format,
          teamSize: st.teamSize,
          startET: startText,
          channelId: ch.id,
          messageId: msg.id,
        }).catch(e => console.error('pushWarCreated error:', e));

        await msg.react('👍').catch(()=>{});
        await msg.react('👎').catch(()=>{});
        await msg.react('🛑').catch(()=>{});

        await interaction.editReply({
          content: `✅ Created **War Sign-up #${st.warId}** in <#${ch.id}>.\n${miniSummary(st)}`,
          components: [],
        });

        wizard.delete(interaction.user.id);
        return;
      }
    }

  } catch (e) {
    console.error('INTERACTION ERROR:', e);
    try {
      if (interaction.isRepliable?.()) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '⚠️ Something went wrong.', flags: 1 << 6 });
        } else if (interaction.followUp) {
          await interaction.followUp({ content: '⚠️ Something went wrong.', flags: 1 << 6 });
        }
      }
    } catch {}
  }
});

/* ---------------- Reactions: 👍 / 👎 / 🛑 ---------------- */
async function refreshSignupEmbed(msg, pool) {
  let base = msg.embeds[0]?.toJSON?.() || { title: `War Sign-up #${pool.warId}`, description: '' };
  const yes = formatLines(pool.signups);
  const no  = formatLines(pool.declines);

  // Remove old sections if present
  base.description = base.description
    .replace(/\n?\*\*Joined \(.*?\)\*[\s\S]*/i, '')
    .replace(/\n?\*\*Not participating \(.*?\)\*[\s\S]*/i, '');

  base.description += `\n\n**Joined (${pool.signups.size})**\n${yes}`;
  base.description += `\n\n**Not participating (${pool.declines.size})**\n${no}`;
  base = embedWithWarId(base, pool.warId);
  await msg.edit({ embeds: [base] }).catch(()=>{});
}

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    const msg = reaction.message;
    const pool = msg?.id ? pools.get(msg.id) : null;
    if (!pool) return;

    const name = user.username;
    const tsMs = Date.now();

    if (reaction.emoji.name === '👍') {
      pool.declines.delete(user.id);
      pool.signups.set(user.id, { name, tsMs });
      await refreshSignupEmbed(msg, pool);
      pushResponse({ warId: pool.warId, userId: user.id, name, status: 'yes', tsIso: new Date(tsMs).toISOString() })
        .catch(e => console.error('pushResponse yes:', e));
    }
    if (reaction.emoji.name === '👎') {
      pool.signups.delete(user.id);
      pool.declines.set(user.id, { name, tsMs });
      await refreshSignupEmbed(msg, pool);
      pushResponse({ warId: pool.warId, userId: user.id, name, status: 'no', tsIso: new Date(tsMs).toISOString() })
        .catch(e => console.error('pushResponse no:', e));
    }
    if (reaction.emoji.name === '🛑') {
      await msg.delete().catch(()=>{});
      pools.delete(msg.id);
      warToMessage.forEach((mid, wid) => { if (mid === msg.id) warToMessage.delete(wid); });
    }
  } catch (e) {
    console.error('REACTION ADD ERROR:', e);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    const msg = reaction.message;
    const pool = msg?.id ? pools.get(msg.id) : null;
    if (!pool) return;

    if (reaction.emoji.name === '👍') {
      pool.signups.delete(user.id);
      await refreshSignupEmbed(msg, pool);
    }
    if (reaction.emoji.name === '👎') {
      pool.declines.delete(user.id);
      await refreshSignupEmbed(msg, pool);
    }
  } catch (e) {
    console.error('REACTION REMOVE ERROR:', e);
  }
});

/* ---------------- Startup ---------------- */
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await initSheets();
  initDB(); // ok if no-op
  await registerCommands();
});
client.login(process.env.DISCORD_TOKEN);

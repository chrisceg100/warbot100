// index.js — Date+Time wizard (7-day date dropdown + 4:30–11:30 PM ET time dropdown + “Other…” modal)
// Includes: War ID, 👍 join, 👎 opt-out, 🛑 cancel, Sheets logging, safe replies, Render health server.

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

// ---------- Render health (only if PORT is set) ----------
const RENDER_PORT = Number(process.env.PORT);
if (Number.isFinite(RENDER_PORT) && RENDER_PORT > 0) {
  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WarBot OK\n');
  });
  server.on('error', (e) => console.error('Health server error:', e));
  server.listen(RENDER_PORT, '0.0.0.0', () => console.log(`🌐 Health server :${RENDER_PORT}`));
} else {
  console.log('ℹ️ No PORT provided; skipping HTTP listener (OK for Background Worker).');
}

// ---------- State ----------
/** wizardState[userId] = { warId, teamSize, format, opponent, dateISO, dateLabel, timeValue, timeLabel, startET } */
const wizardState = new Map();
/** pools[msgId] = { warId, signups: Map<userId,{name,tsMs}>, declines: Map<userId,{name,tsMs}> } */
const pools = new Map();
/** warId -> messageId */
const warToMessage = new Map();

// ---------- Helpers ----------
function embedWithWarId(base, warId) {
  const id = String(warId);
  const title = base.title && !/War Sign-up #/i.test(base.title) ? base.title : `War Sign-up #${id}`;
  const desc = base.description || '';
  const ensured = /\*\*War ID:\*/i.test(desc) ? desc : `**War ID:** ${id}\n${desc}`;
  return { ...base, title, description: ensured, footer: { text: `War #${id}` } };
}

function etDateAddDays(days) {
  // Build a Date representing "today in ET" + days, at noon ET to avoid DST edge cases during format.
  const now = new Date();
  const utc = now.getTime() + (days * 24 * 60 * 60 * 1000);
  const d = new Date(utc);
  // We'll format using ET and only need labels and YYYY-MM-DD strings; noon choice avoids DST traps.
  d.setUTCHours(16, 0, 0, 0); // ~noon ET (16:00 UTC when ET=UTC-4)
  return d;
}
function etFormatDateLabel(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}
function etFormatYYYYMMDD(d) {
  // Get YYYY-MM-DD for ET calendar date
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  // en-CA gives YYYY-MM-DD already
  return parts;
}
function buildDateChoices7() {
  const opts = [];
  for (let i = 0; i < 7; i++) {
    const d = etDateAddDays(i);
    opts.push({ label: etFormatDateLabel(d), value: etFormatYYYYMMDD(d) });
  }
  return opts;
}
function buildTimeChoicesEvening() {
  // 4:30 PM to 11:30 PM ET, every 30 minutes
  const times = [];
  let h = 16, m = 30; // 16:30
  while (h < 23 || (h === 23 && m <= 30)) {
    const label = new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
    });
    const val = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; // 24h "HH:MM"
    times.push({ label, value: val });
    m += 30;
    if (m >= 60) { m = 0; h += 1; }
  }
  // Add an "Other…" item to allow manual times outside the band
  times.push({ label: 'Other…', value: 'other' });
  return times;
}
function dateMenu(selectedValue) {
  const opts = buildDateChoices7().map(({ label, value }) => ({ label, value, default: selectedValue === value }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:w:date')
      .setPlaceholder('Pick date (ET) — next 7 days')
      .addOptions(...opts) // ≤ 7
  );
}
function timeMenu(selectedValue) {
  const opts = buildTimeChoicesEvening().map(({ label, value }) => ({ label, value, default: selectedValue === value }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:w:clock')
      .setPlaceholder('Pick time (ET) — 4:30 PM to 11:30 PM')
      .addOptions(...opts) // 15 + 1 ("Other…") ≤ 25
  );
}
function teamSizeMenu(selected) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:w:size')
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
      .setPlaceholder('Select Format (BO3 / BO5)')
      .addOptions(
        { label: 'Best of 3', value: 'BO3', default: selected === 'BO3' },
        { label: 'Best of 5', value: 'BO5', default: selected === 'BO5' },
      )
  );
}
function navButtons(nextEnabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wb:w:next').setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(!nextEnabled),
    new ButtonBuilder().setCustomId('wb:w:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}

// pretty list for embed updates
function formatLines(map) {
  const list = [...map.values()].sort((a, b) => a.tsMs - b.tsMs);
  if (!list.length) return '_none yet_';
  return list.map(v => {
    const dt = new Date(v.tsMs).toLocaleString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      month: 'numeric', day: 'numeric', timeZone: 'America/New_York'
    });
    return `${v.name} (${dt} ET)`;
  }).join('\n');
}

// Safe ephemeral responder (avoids “Unknown interaction”)
async function safeEphemeral(interaction, content) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp?.({ content, flags: 1 << 6 });
    } else {
      await interaction.reply({ content, flags: 1 << 6 });
    }
  } catch (e) {
    console.error('safeEphemeral error:', e);
  }
}

// ---------- Commands ----------
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

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.on('interactionCreate', async (interaction) => {
  try {
    // --- slash commands
    if (interaction.isChatInputCommand() && interaction.commandName === 'warbot') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'new') {
        // New War ID from Sheets; fallback to timestamp if Sheets hiccups
        let warId = await getNextWarId().catch(() => null);
        if (!Number.isInteger(warId)) {
          const n = new Date();
          warId = Number(`${n.getUTCFullYear()}${String(n.getUTCMonth()+1).padStart(2,'0')}${String(n.getUTCDate()).padStart(2,'0')}${String(n.getUTCHours()).padStart(2,'0')}${String(n.getUTCMinutes()).padStart(2,'0')}`);
        }
        wizardState.set(interaction.user.id, {
          warId, teamSize: null, format: null, opponent: null,
          dateISO: null, dateLabel: null,
          timeValue: null, timeLabel: null, startET: null
        });

        await interaction.reply({
          content:
            `🧭 **War Wizard** — **War ID ${warId}**\n` +
            `1) Choose **Team Size**\n2) Choose **Format**\n3) Enter **Opponent** & pick **Date** and **Time**\n\n` +
            `Your selections will remain visible below.`,
          components: [teamSizeMenu(null), formatMenu(null), navButtons(false)],
          flags: 1 << 6, // ephemeral
        });
        return;
      }

      if (sub === 'cancel') {
        const warId = interaction.options.getInteger('war_id', true);
        const messageId = warToMessage.get(String(warId));
        if (!messageId) return safeEphemeral(interaction, `❌ I can’t find a live sign-up for War ID ${warId}.`);

        const ch = await client.channels.fetch(process.env.WAR_CHANNEL_ID).catch(()=>null);
        const msg = ch ? await ch.messages.fetch(messageId).catch(()=>null) : null;
        if (msg) await msg.delete().catch(()=>{});
        warToMessage.delete(String(warId));
        for (const [mid] of pools) if (mid === messageId) pools.delete(mid);
        return safeEphemeral(interaction, `🛑 War Sign-up #${warId} has been cancelled.`);
      }
    }

    // --- wizard dropdowns
    if (interaction.isStringSelectMenu()) {
      const st = wizardState.get(interaction.user.id);
      if (!st) return;

      if (interaction.customId === 'wb:w:size') {
        st.teamSize = interaction.values[0];
        return interaction.update({
          content: `🧭 **War Wizard** — **War ID ${st.warId}**\nTeam Size: **${st.teamSize || '—'}** | Format: **${st.format || '—'}**\nSelect both, then click **Next**.`,
          components: [teamSizeMenu(st.teamSize), formatMenu(st.format), navButtons(!!(st.teamSize && st.format))],
        });
      }

      if (interaction.customId === 'wb:w:format') {
        st.format = interaction.values[0];
        return interaction.update({
          content: `🧭 **War Wizard** — **War ID ${st.warId}**\nTeam Size: **${st.teamSize || '—'}** | Format: **${st.format || '—'}**\nSelect both, then click **Next**.`,
          components: [teamSizeMenu(st.teamSize), formatMenu(st.format), navButtons(!!(st.teamSize && st.format))],
        });
      }

      if (interaction.customId === 'wb:w:date') {
        st.dateISO = interaction.values[0]; // YYYY-MM-DD (ET)
        st.dateLabel = buildDateChoices7().find(o => o.value === st.dateISO)?.label || st.dateISO;
        // If time already chosen, compose startET
        if (st.timeLabel) st.startET = `${st.dateLabel}, ${st.timeLabel} ET`;
        return interaction.update({
          content:
            `🧭 **War Wizard** — **War ID ${st.warId}**\n` +
            `Opponent: **${st.opponent || '—'}**\n` +
            `Date (ET): **${st.dateLabel || '—'}**\n` +
            `Time (ET): **${st.timeLabel || '—'}**\n` +
            `Enter opponent and select both date & time, then **Create Sign-up**.`,
          components: [
            dateMenu(st.dateISO),
            timeMenu(st.timeValue),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('wb:w:create').setLabel('Create Sign-up').setStyle(ButtonStyle.Success)
                .setDisabled(!(st.opponent && st.dateISO && (st.timeValue || st.startET))),
              new ButtonBuilder().setCustomId('wb:w:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
      }

      if (interaction.customId === 'wb:w:clock') {
        const val = interaction.values[0];
        if (val === 'other') {
          // Open modal for custom time (ET)
          const modal = new ModalBuilder().setCustomId('wb:w:othertime').setTitle('Custom Time (ET)');
          const txt = new TextInputBuilder()
            .setCustomId('wb:w:othertxt')
            .setLabel('Enter time in ET (e.g., "1:05 AM" or "13:05")')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(40);
          modal.addComponents(new ActionRowBuilder().addComponents(txt));
          await interaction.showModal(modal);
          return;
        }
        // Regular band time
        st.timeValue = val; // "HH:MM" 24h ET
        // Turn label into 12-hour formatted display
        const [H, M] = val.split(':').map(n => parseInt(n, 10));
        const label = new Date(Date.UTC(2000, 0, 1, H, M)).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
        });
        st.timeLabel = label;
        if (st.dateLabel) st.startET = `${st.dateLabel}, ${st.timeLabel} ET`;

        return interaction.update({
          content:
            `🧭 **War Wizard** — **War ID ${st.warId}**\n` +
            `Opponent: **${st.opponent || '—'}**\n` +
            `Date (ET): **${st.dateLabel || '—'}**\n` +
            `Time (ET): **${st.timeLabel || '—'}**\n` +
            `Enter opponent and select both date & time, then **Create Sign-up**.`,
          components: [
            dateMenu(st.dateISO),
            timeMenu(st.timeValue),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('wb:w:create').setLabel('Create Sign-up').setStyle(ButtonStyle.Success)
                .setDisabled(!(st.opponent && st.dateISO && (st.timeValue || st.startET))),
              new ButtonBuilder().setCustomId('wb:w:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
      }
    }

    // --- wizard buttons & modal
    if (interaction.isButton()) {
      const st = wizardState.get(interaction.user.id);

      if (interaction.customId === 'wb:w:cancel') {
        wizardState.delete(interaction.user.id);
        return interaction.update({ content: '❌ Wizard cancelled.', components: [] });
      }

      if (interaction.customId === 'wb:w:next') {
        if (!st || !st.teamSize || !st.format) return safeEphemeral(interaction, 'Please choose team size and format first.');
        const modal = new ModalBuilder().setCustomId('wb:w:oppmodal').setTitle('Enter Opponent');
        const opp = new TextInputBuilder()
          .setCustomId('wb:w:opptxt')
          .setLabel('Opponent name')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(opp));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === 'wb:w:create') {
        if (!st || !st.opponent || !st.dateISO || !(st.timeValue || st.startET)) {
          return safeEphemeral(interaction, 'Please enter opponent and pick both date & time.');
        }
        const chId = process.env.WAR_CHANNEL_ID;
        const ch = chId ? await client.channels.fetch(chId).catch(()=>null) : null;
        if (!ch || !ch.isTextBased()) return safeEphemeral(interaction, '❌ WAR_CHANNEL_ID is missing or invalid.');

        const startText = st.startET || `${st.dateLabel}, ${st.timeLabel} ET`;

        let embed = {
          title: `War Sign-up #${st.warId}`,
          description:
            `**War ID:** ${st.warId}\n` +
            `**Opponent:** ${st.opponent}\n` +
            `**Format:** ${st.format}\n` +
            `**Team Size:** ${st.teamSize}v${st.teamSize}\n` +
            `**Start (ET):** ${startText}\n\n` +
            `React 👍 to **join** (timestamp recorded).\nReact 👎 if you **cannot** play (opt-out).\nReact 🛑 to **cancel** this sign-up.`,
          footer: { text: `War #${st.warId}` }
        };
        embed = embedWithWarId(embed, st.warId);

        const msg = await ch.send({ embeds: [embed] });
        warToMessage.set(String(st.warId), msg.id);
        pools.set(msg.id, { warId: st.warId, signups: new Map(), declines: new Map() });

        // Sheets log
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

        wizardState.delete(interaction.user.id);
        return interaction.update({
          content:
            `✅ **War Sign-up #${st.warId}** created in <#${ch.id}>.\n` +
            `Opponent: **${st.opponent}** | Format: **${st.format}** | Team: **${st.teamSize}v${st.teamSize}** | Start: **${startText}**`,
          components: [],
        });
      }
    }

    // Opponent modal submit
    if (interaction.isModalSubmit() && interaction.customId === 'wb:w:oppmodal') {
      const st = wizardState.get(interaction.user.id);
      if (!st) return;
      st.opponent = interaction.fields.getTextInputValue('wb:w:opptxt');
      return interaction.reply({
        content:
          `🧭 **War Wizard** — **War ID ${st.warId}**\n` +
          `Opponent: **${st.opponent}**\n` +
          `Pick **Date** and **Time (ET)** below, then **Create Sign-up**.`,
        components: [
          dateMenu(st.dateISO),
          timeMenu(st.timeValue),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('wb:w:create').setLabel('Create Sign-up').setStyle(ButtonStyle.Success)
              .setDisabled(!(st.opponent && st.dateISO && (st.timeValue || st.startET))),
            new ButtonBuilder().setCustomId('wb:w:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
        flags: 1 << 6,
      });
    }

    // Custom time modal (Other…)
    if (interaction.isModalSubmit() && interaction.customId === 'wb:w:othertime') {
      const st = wizardState.get(interaction.user.id);
      if (!st) return;
      const txt = interaction.fields.getTextInputValue('wb:w:othertxt').trim();
      // Store as-is; user provided ET time. We’ll display with date if present.
      st.timeValue = null; // not from dropdown
      st.timeLabel = txt;
      if (st.dateLabel) st.startET = `${st.dateLabel}, ${st.timeLabel} ET`;
      await interaction.reply({
        content:
          `🧭 **War Wizard** — **War ID ${st.warId}**\n` +
          `Opponent: **${st.opponent || '—'}**\n` +
          `Date (ET): **${st.dateLabel || '—'}**\n` +
          `Time (ET): **${st.timeLabel || '—'}**\n` +
          `Select both date & time, then **Create Sign-up**.`,
        components: [
          dateMenu(st.dateISO),
          timeMenu(null),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('wb:w:create').setLabel('Create Sign-up').setStyle(ButtonStyle.Success)
              .setDisabled(!(st.opponent && st.dateISO && (st.timeLabel || st.timeValue))),
            new ButtonBuilder().setCustomId('wb:w:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
        flags: 1 << 6,
      });
    }

  } catch (e) {
    console.error('INTERACTION ERROR:', e);
    try {
      if (interaction.isRepliable?.()) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '⚠️ Something went wrong.', flags: 1 << 6 });
        } else {
          await interaction.followUp?.({ content: '⚠️ Something went wrong.', flags: 1 << 6 });
        }
      }
    } catch {}
  }
});

// ---------- Reactions: 👍 join / 👎 opt-out / 🛑 cancel ----------
async function updateSignupEmbed(msg, pool) {
  let base = msg.embeds[0]?.toJSON?.() || { title: `War Sign-up #${pool.warId}`, description: '' };
  const yesLines = formatLines(pool.signups);
  const noLines  = formatLines(pool.declines);

  base.description = base.description
    .replace(/\n?\*\*Joined.*$/s, '')
    .replace(/\n?\*\*Not participating.*$/s, '');

  base.description += `\n\n**Joined (${pool.signups.size})**\n${yesLines}`;
  base.description += `\n\n**Not participating (${pool.declines.size})**\n${noLines}`;
  base = embedWithWarId(base, pool.warId);
  await msg.edit({ embeds: [base] }).catch(()=>{});
}

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    const msg = reaction.message;
    if (!msg?.id) return;
    const pool = pools.get(msg.id);
    if (!pool) return;

    const name = user.username;
    const tsMs = Date.now();

    if (reaction.emoji.name === '👍') {
      pool.declines.delete(user.id);
      pool.signups.set(user.id, { name, tsMs });
      await updateSignupEmbed(msg, pool);
      pushResponse({ warId: pool.warId, userId: user.id, name, status: 'yes', tsIso: new Date(tsMs).toISOString() })
        .catch(e => console.error('pushResponse yes:', e));
    }
    if (reaction.emoji.name === '👎') {
      pool.signups.delete(user.id);
      pool.declines.set(user.id, { name, tsMs });
      await updateSignupEmbed(msg, pool);
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
    if (!msg?.id) return;
    const pool = pools.get(msg.id);
    if (!pool) return;

    if (reaction.emoji.name === '👍') {
      pool.signups.delete(user.id);
      await updateSignupEmbed(msg, pool);
    }
    if (reaction.emoji.name === '👎') {
      pool.declines.delete(user.id);
      await updateSignupEmbed(msg, pool);
    }
  } catch (e) {
    console.error('REACTION REMOVE ERROR:', e);
  }
});

// ---------- Startup ----------
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await initSheets();
  initDB(); // no-op
  await registerCommands();
});

client.login(process.env.DISCORD_TOKEN);

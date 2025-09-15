// index.js — WarBot (evening window, robust interactions)
// ENV required: DISCORD_TOKEN, CLIENT_ID, GUILD_ID, WAR_CHANNEL_ID
// Sheets hooks expected: initSheets(), getNextWarId(), pushWarCreated(), pushResponse()
process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION:', e));
process.on('uncaughtException',  (e) => console.error('UNCAUGHT EXCEPTION:', e));

import 'dotenv/config';
import http from 'http';
import {
  Client, GatewayIntentBits, Partials,
  REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { initSheets, getNextWarId, pushWarCreated, pushResponse } from './sheets.js';
import { initDB } from './db.js';

/* ---------------- Health server for Render (optional) ---------------- */
const BUILD_NAME = process.env.BUILD_NAME || process.env.RENDER_GIT_COMMIT || 'local';
console.log(`🚀 Build: ${BUILD_NAME}`);
const PORT = Number(process.env.PORT);
if (Number.isFinite(PORT) && PORT > 0) {
  http.createServer((_, res) => { res.writeHead(200); res.end('OK'); })
      .listen(PORT, '0.0.0.0', () => console.log(`🌐 Health :${PORT}`));
} else {
  console.log('ℹ️ No PORT provided; skipping HTTP listener (Background Worker OK).');
}

/* ---------------- In-memory state ---------------- */
// per-user wizard state
const wiz = new Map();
/** pools[msgId] = { warId, signups: Map<userId,{name,tsMs}>, declines: Map<userId,{name,tsMs}> } */
const pools = new Map();
/** warId -> messageId */
const warToMessage = new Map();

/* ---------------- Small utils ---------------- */
function ensureWarEmbed(base, warId) {
  const id = String(warId);
  const title = base.title?.includes('#') ? base.title : `War Sign-up #${id}`;
  const desc = base.description?.includes('**War ID:**')
    ? base.description
    : `**War ID:** ${id}\n${base.description ?? ''}`;
  return { ...base, title, description: desc, footer: { text: `War #${id}` } };
}

function etAddDays(days) {
  const now = new Date();
  const d = new Date(now.getTime() + days * 86400000);
  // anchor time so labels are consistent
  d.setUTCMinutes(0, 0, 0);
  return d;
}
function etDateLabel(d) {
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    timeZone: 'America/New_York'
  });
}
function etYYYYMMDD(d) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: 'America/New_York'
  }).format(d);
}
function buildDateChoices7() {
  // today + next 6
  const opts = [];
  for (let i = 0; i < 7; i++) {
    const d = etAddDays(i);
    opts.push({ label: etDateLabel(d), value: etYYYYMMDD(d) });
  }
  return opts;
}

// 4:30 PM (16:30) → 11:30 PM (23:30) ET, 30-min steps, plus "Other…"
function buildTimeChoicesEvening() {
  const times = [];
  let hour = 16, min = 30;
  while (hour < 23 || (hour === 23 && min <= 30)) {
    const label = new Date(Date.UTC(2000, 0, 1, hour, min)).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
    });
    const value = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    times.push({ label, value });
    min += 30;
    if (min >= 60) { min = 0; hour += 1; }
  }
  times.push({ label: 'Other…', value: 'other' });
  return times; // <= 16 options -> well under Discord 25 cap
}

function summary(st) {
  return `**War ID:** ${st.warId}\n` +
    `Opponent: **${st.opponent || '—'}**  |  Team: **${st.teamSize || '—'}v${st.teamSize || '—'}**  |  Format: **${st.format || '—'}**\n` +
    `Date: **${st.dateLabel || '—'}**  |  Time: **${st.timeLabel || '—'}**`;
}
function canCreate(st) {
  return !!(st.opponent && st.teamSize && st.format && st.dateLabel && (st.timeLabel || st.timeValue));
}
function linesFrom(map) {
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

/* ---------------- UI builders ---------------- */
const teamSizeMenu = (selected) =>
  new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:size')
      .setPlaceholder('Team Size (6 / 7 / 8)')
      .addOptions(
        { label: '6v6', value: '6', default: selected === '6' },
        { label: '7v7', value: '7', default: selected === '7' },
        { label: '8v8', value: '8', default: selected === '8' },
      )
  );

const formatMenu = (selected) =>
  new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:format')
      .setPlaceholder('Format (BO3 / BO5)')
      .addOptions(
        { label: 'Best of 3', value: 'BO3', default: selected === 'BO3' },
        { label: 'Best of 5', value: 'BO5', default: selected === 'BO5' },
      )
  );

const dateMenu = (selectedValue) => {
  const opts = buildDateChoices7().map(o => ({ ...o, default: selectedValue === o.value }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:date')
      .setPlaceholder('Pick date (ET) — today + 6 days')
      .addOptions(...opts)
  );
};

const timeMenu = (selectedValue) => {
  const opts = buildTimeChoicesEvening().map(o => ({
    label: o.label, value: o.value, default: selectedValue === o.value
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:time')
      .setPlaceholder('Pick time (ET) — 4:30 PM to 11:30 PM')
      .addOptions(...opts)
  );
};

const opponentButtons = (hasOpponent, ready) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wb:setopp').setLabel(hasOpponent ? 'Change Opponent' : 'Set Opponent').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('wb:create').setLabel('Create Sign-up').setStyle(ButtonStyle.Success).setDisabled(!ready),
    new ButtonBuilder().setCustomId('wb:cancelwiz').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

/* ---------------- Command registration ---------------- */
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName('warbot')
      .setDescription('WarBot controls')
      .addSubcommand(s => s.setName('new').setDescription('Create a War Sign-up'))
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

/* ---------------- Discord client ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

/* ---------------- Interactions ---------------- */
client.on('interactionCreate', async (interaction) => {
  try {
    /* Slash: /warbot new */
    if (interaction.isChatInputCommand() && interaction.commandName === 'warbot' && interaction.options.getSubcommand() === 'new') {
      // Reply immediately (ephemeral) and then update using interaction.editReply
      await interaction.reply({ content: '⏳ Preparing setup…', flags: 1 << 6 });

      // Reserve a War ID (fallback to timestamp if Sheets not available)
      let warId;
      try { warId = await getNextWarId(); } catch { warId = null; }
      if (!Number.isInteger(warId)) {
        const n = new Date();
        warId = Number(
          `${n.getUTCFullYear()}${String(n.getUTCMonth()+1).padStart(2,'0')}${String(n.getUTCDate()).padStart(2,'0')}${String(n.getUTCHours()).padStart(2,'0')}${String(n.getUTCMinutes()).padStart(2,'0')}`
        );
      }

      const st = {
        warId, opponent: null, teamSize: null, format: null,
        dateISO: null, dateLabel: null, timeValue: null, timeLabel: null, startET: null,
        wizardMessageId: null, channelId: interaction.channelId,
      };
      wiz.set(interaction.user.id, st);

      // Send the actual wizard page (edit the ephemeral reply)
      const msg = await interaction.editReply({
        content:
          `🧭 **War Setup** — **War ID ${st.warId}**\n` +
          `1) Set opponent  2) Pick team size & format  3) Choose date/time  4) Create sign-up\n\n` +
          summary(st),
        components: [teamSizeMenu(), formatMenu(), dateMenu(), timeMenu(), opponentButtons(false, false)]
      });
      // store message id so modal submits can edit the same wizard
      st.wizardMessageId = msg.id;
      return;
    }

    /* Slash: /warbot cancel */
    if (interaction.isChatInputCommand() && interaction.commandName === 'warbot' && interaction.options.getSubcommand() === 'cancel') {
      await interaction.reply({ content: '⏳ Cancelling…', flags: 1 << 6 });
      const warId = interaction.options.getInteger('war_id', true);
      const msgId = warToMessage.get(String(warId));
      if (!msgId) return interaction.editReply(`❌ No active sign-up for War ID ${warId}.`);
      const ch = await client.channels.fetch(process.env.WAR_CHANNEL_ID).catch(()=>null);
      const msg = ch ? await ch.messages.fetch(msgId).catch(()=>null) : null;
      if (msg) await msg.delete().catch(()=>{});
      warToMessage.delete(String(warId));
      pools.delete(msgId);
      return interaction.editReply(`🛑 War Sign-up #${warId} cancelled and message removed.`);
    }

    /* Select menus update the message via interaction.update(...) */
    if (interaction.isStringSelectMenu()) {
      const st = wiz.get(interaction.user.id);
      if (!st) return;

      if (interaction.customId === 'wb:size') {
        st.teamSize = interaction.values[0];
      } else if (interaction.customId === 'wb:format') {
        st.format = interaction.values[0];
      } else if (interaction.customId === 'wb:date') {
        st.dateISO = interaction.values[0];
        st.dateLabel = buildDateChoices7().find(o => o.value === st.dateISO)?.label || st.dateISO;
        if (st.timeLabel) st.startET = `${st.dateLabel}, ${st.timeLabel} ET`;
      } else if (interaction.customId === 'wb:time') {
        if (interaction.values[0] === 'other') {
          // open modal; DON'T defer/update first
          const modal = new ModalBuilder().setCustomId('wb:time:other').setTitle('Custom Time (ET)');
          const txt = new TextInputBuilder()
            .setCustomId('othertime')
            .setLabel('Enter time in ET (e.g., "10:15 PM")')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(40);
          modal.addComponents(new ActionRowBuilder().addComponents(txt));
          await interaction.showModal(modal);
          return;
        } else {
          const val = interaction.values[0];
          st.timeValue = val;
          const [H, M] = val.split(':').map(n => parseInt(n, 10));
          st.timeLabel = new Date(Date.UTC(2000, 0, 1, H, M)).toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
          });
          if (st.dateLabel) st.startET = `${st.dateLabel}, ${st.timeLabel} ET`;
        }
      }

      const ready = canCreate(st);
      await interaction.update({
        content: `🧭 **War Setup** — **War ID ${st.warId}**\n${summary(st)}`,
        components: [teamSizeMenu(st.teamSize), formatMenu(st.format), dateMenu(st.dateISO), timeMenu(st.timeValue), opponentButtons(!!st.opponent, ready)]
      });
      return;
    }

    /* Buttons use interaction.update(...) */
    if (interaction.isButton()) {
      const st = wiz.get(interaction.user.id);

      if (interaction.customId === 'wb:cancelwiz') {
        wiz.delete(interaction.user.id);
        await interaction.update({ content: '❌ Setup cancelled.', components: [] });
        return;
      }

      if (interaction.customId === 'wb:setopp') {
        const modal = new ModalBuilder().setCustomId('wb:opp:modal').setTitle('Set Opponent');
        const opp = new TextInputBuilder()
          .setCustomId('opp')
          .setLabel('Opponent')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50);
        modal.addComponents(new ActionRowBuilder().addComponents(opp));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === 'wb:create') {
        if (!st || !canCreate(st)) {
          // update message in place, no new interaction
          await interaction.update({ content: '❌ Missing info. Please complete all fields.', components: [] });
          return;
        }
        const chId = process.env.WAR_CHANNEL_ID;
        const ch = chId ? await client.channels.fetch(chId).catch(()=>null) : null;
        if (!ch || !ch.isTextBased()) {
          await interaction.update({ content: '❌ WAR_CHANNEL_ID is missing or invalid.', components: [] });
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
        embed = ensureWarEmbed(embed, st.warId);

        const msg = await ch.send({ embeds: [embed] });
        warToMessage.set(String(st.warId), msg.id);
        pools.set(msg.id, { warId: st.warId, signups: new Map(), declines: new Map() });

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

        wiz.delete(interaction.user.id);
        await interaction.update({
          content: `✅ Created **War Sign-up #${st.warId}** in <#${ch.id}>.\n${summary(st)}`,
          components: []
        });
        return;
      }
    }

    /* Modal submissions */
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'wb:opp:modal') {
        const st = wiz.get(interaction.user.id);
        if (!st) return;
        st.opponent = interaction.fields.getTextInputValue('opp').trim();
        const ready = canCreate(st);

        // Try to edit the original wizard message directly
        try {
          const ch = await client.channels.fetch(st.channelId);
          const msg = await ch.messages.fetch(st.wizardMessageId);
          await msg.edit({
            content: `🧭 **War Setup** — **War ID ${st.warId}**\n${summary(st)}`,
            components: [teamSizeMenu(st.teamSize), formatMenu(st.format), dateMenu(st.dateISO), timeMenu(st.timeValue), opponentButtons(!!st.opponent, ready)]
          });
        } catch (_) {}
        // Acknowledge the modal
        await interaction.reply({ content: '✅ Opponent set.', flags: 1 << 6 });
        return;
      }

      if (interaction.customId === 'wb:time:other') {
        const st = wiz.get(interaction.user.id);
        if (!st) return;
        const txt = interaction.fields.getTextInputValue('othertime').trim();
        st.timeValue = null;
        st.timeLabel = txt;
        if (st.dateLabel) st.startET = `${st.dateLabel}, ${st.timeLabel} ET`;
        const ready = canCreate(st);

        try {
          const ch = await client.channels.fetch(st.channelId);
          const msg = await ch.messages.fetch(st.wizardMessageId);
          await msg.edit({
            content: `🧭 **War Setup** — **War ID ${st.warId}**\n${summary(st)}`,
            components: [teamSizeMenu(st.teamSize), formatMenu(st.format), dateMenu(st.dateISO), timeMenu(null), opponentButtons(!!st.opponent, ready)]
          });
        } catch (_) {}
        await interaction.reply({ content: '✅ Time set.', flags: 1 << 6 });
        return;
      }
    }
  } catch (e) {
    console.error('INTERACTION ERROR:', e);
    try {
      if (interaction.isRepliable?.()) {
        // Best-effort ack if still possible
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '⚠️ Something went wrong.', flags: 1 << 6 });
        }
      }
    } catch {}
  }
});

/* ---------------- Reactions: 👍 / 👎 / 🛑 ---------------- */
async function refreshSignupEmbed(msg, pool) {
  let base = msg.embeds[0]?.toJSON?.() || { title: `War Sign-up #${pool.warId}`, description: '' };
  const yes = linesFrom(pool.signups);
  const no  = linesFrom(pool.declines);
  base.description = base.description
    .replace(/\n?\*\*Joined \(\d+\)\*[\s\S]*?(?=\n\*\*|$)/i, '')
    .replace(/\n?\*\*Not participating \(\d+\)\*[\s\S]*?(?=\n\*\*|$)/i, '');
  base.description += `\n\n**Joined (${pool.signups.size})**\n${yes}`;
  base.description += `\n\n**Not participating (${pool.declines.size})**\n${no}`;
  base = ensureWarEmbed(base, pool.warId);
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
  await initSheets().catch(e => console.error('initSheets error:', e));
  initDB();
  await registerCommands().catch(e => console.error('registerCommands error:', e));
});
client.login(process.env.DISCORD_TOKEN);

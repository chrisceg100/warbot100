// index.js — WarBot (static time labels, safer interactions)
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

/* ------------------- health server for Render (optional) ------------------- */
const PORT = Number(process.env.PORT);
if (Number.isFinite(PORT) && PORT > 0) {
  http.createServer((_, res) => { res.writeHead(200); res.end('OK'); })
      .listen(PORT, '0.0.0.0', () => console.log(`🌐 Health :${PORT}`));
} else {
  console.log('ℹ️ No PORT provided; skipping HTTP listener (OK for Background Worker).');
}

/* ----------------------------- in-memory state ----------------------------- */
// per-user wizard state
const wiz = new Map();
/** pools[msgId] = { warId, signups: Map<userId,{name,tsMs}>, declines: Map<userId,{name,tsMs}> } */
const pools = new Map();
/** warId -> messageId (for /warbot cancel) */
const warToMessage = new Map();

/* ------------------------------- helpers ---------------------------------- */
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName('warbot')
      .setDescription('WarBot controls')
      .addSubcommand(s => s.setName('new').setDescription('Create a War Sign-up'))
      .addSubcommand(s => s.setName('cancel')
        .setDescription('Cancel a War Sign-up by War ID')
        .addIntegerOption(o => o.setName('war_id').setDescription('War ID to cancel').setRequired(true)))
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: cmds }
  );
  console.log('✅ Registered /warbot commands');
}

function ensureWarEmbed(base, warId) {
  const title = base.title?.includes('#') ? base.title : `War Sign-up #${warId}`;
  const hasId = /\*\*War ID:\*\*/.test(base.description || '');
  const description = hasId ? base.description : `**War ID:** ${warId}\n${base.description ?? ''}`;
  return { ...base, title, description, footer: { text: `War #${warId}` } };
}

function buildDateChoices7() {
  const now = new Date();
  const opts = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const label = d.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      timeZone: 'America/New_York'
    });
    // store a simple YYYY-MM-DD as value (string)
    const value = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      timeZone: 'America/New_York'
    }).format(d);
    opts.push({ label, value });
  }
  return opts;
}

// STATIC TEXT LABELS — no timezone math, exactly what the user sees
function buildTimeChoicesEvening() {
  return [
    { label: '4:30 PM ET', value: '430pm' },
    { label: '5:00 PM ET', value: '500pm' },
    { label: '5:30 PM ET', value: '530pm' }
  ];
}

function summary(st) {
  return `**War ID:** ${st.warId}\n` +
    `Opponent: **${st.opponent || '—'}**  |  Team: **${st.teamSize || '—'}v${st.teamSize || '—'}**  |  Format: **${st.format || '—'}**\n` +
    `Date: **${st.dateLabel || '—'}**  |  Time: **${st.timeLabel || '—'}**`;
}
function canCreate(st) {
  return !!(st.opponent && st.teamSize && st.format && st.dateLabel && st.timeLabel);
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
async function safeEphemeral(interaction, content) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content, flags: 1 << 6 });
    } else {
      await interaction.followUp({ content, flags: 1 << 6 });
    }
  } catch (e) {
    if (e?.code !== 10062 && e?.code !== 40060) console.warn('safeEphemeral error:', e?.code || e);
  }
}

/* --------------------------- components ---------------------------------- */
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
    label: o.label,
    value: o.value,
    default: selectedValue === o.value
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:time')
      .setPlaceholder('Pick time (ET): 4:30 / 5:00 / 5:30 PM')
      .addOptions(...opts)
  );
};

const opponentButtons = (hasOpponent, ready) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wb:setopp').setLabel(hasOpponent ? 'Change Opponent' : 'Set Opponent').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('wb:create').setLabel('Create Sign-up').setStyle(ButtonStyle.Success).setDisabled(!ready),
    new ButtonBuilder().setCustomId('wb:cancelwiz').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

/* -------------------------------- client --------------------------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

/* -------------------------- interaction flow ----------------------------- */
client.on('interactionCreate', async (interaction) => {
  try {
    // /warbot new
    if (interaction.isChatInputCommand() && interaction.commandName === 'warbot' && interaction.options.getSubcommand() === 'new') {
      // Acknowledge immediately to avoid "Unknown interaction"
      await interaction.deferReply({ flags: 1 << 6 });

      // war id from Sheets (fallback to UTC timestamp if unavailable)
      let warId;
      try { warId = await getNextWarId(); } catch { warId = null; }
      if (!Number.isInteger(warId)) {
        const n = new Date();
        warId = Number(`${n.getUTCFullYear()}${String(n.getUTCMonth()+1).padStart(2,'0')}${String(n.getUTCDate()).padStart(2,'0')}${String(n.getUTCHours()).padStart(2,'0')}${String(n.getUTCMinutes()).padStart(2,'0')}`);
      }

      const st = {
        warId, opponent: null, teamSize: null, format: null,
        dateISO: null, dateLabel: null, timeValue: null, timeLabel: null, startET: null,
        wizardMessageId: null, channelId: interaction.channelId,
      };
      wiz.set(interaction.user.id, st);

      const msg = await interaction.editReply({
        content:
          `🧭 **War Setup** — **War ID ${st.warId}**\n` +
          `1) Set opponent  2) Pick team size & format  3) Choose date/time  4) Create sign-up\n\n` +
          summary(st),
        components: [teamSizeMenu(), formatMenu(), dateMenu(), timeMenu(), opponentButtons(false, false)]
      });
      st.wizardMessageId = msg.id;
      return;
    }

    // /warbot cancel
    if (interaction.isChatInputCommand() && interaction.commandName === 'warbot' && interaction.options.getSubcommand() === 'cancel') {
      await interaction.deferReply({ flags: 1 << 6 });
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

    // select menus
    if (interaction.isStringSelectMenu()) {
      const st = wiz.get(interaction.user.id);
      if (!st) return;

      if (interaction.customId === 'wb:size') st.teamSize = interaction.values[0];
      if (interaction.customId === 'wb:format') st.format = interaction.values[0];

      if (interaction.customId === 'wb:date') {
        st.dateISO = interaction.values[0];
        st.dateLabel = buildDateChoices7().find(o => o.value === st.dateISO)?.label || st.dateISO;
        if (st.timeLabel) st.startET = `${st.dateLabel}, ${st.timeLabel}`;
      }

      if (interaction.customId === 'wb:time') {
        const val = interaction.values[0];
        const display = buildTimeChoicesEvening().find(o => o.value === val)?.label || val;
        st.timeValue = val;
        st.timeLabel = display; // store the exact text users saw
        if (st.dateLabel) st.startET = `${st.dateLabel}, ${st.timeLabel}`;
      }

      const ready = canCreate(st);
      await interaction.update({
        content: `🧭 **War Setup** — **War ID ${st.warId}**\n${summary(st)}`,
        components: [teamSizeMenu(st.teamSize), formatMenu(st.format), dateMenu(st.dateISO), timeMenu(st.timeValue), opponentButtons(!!st.opponent, ready)]
      });
      return;
    }

    // buttons
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
        await interaction.deferUpdate().catch(()=>{});
        if (!st || !canCreate(st)) {
          await safeEphemeral(interaction, '❌ Missing info. Please complete all fields.');
          return;
        }

        const chId = process.env.WAR_CHANNEL_ID;
        const ch = chId ? await client.channels.fetch(chId).catch(()=>null) : null;
        if (!ch || !ch.isTextBased()) {
          await safeEphemeral(interaction, '❌ WAR_CHANNEL_ID is missing or invalid.');
          return;
        }

        const startText = st.startET || `${st.dateLabel}, ${st.timeLabel}`;
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
        await safeEphemeral(interaction, `✅ Created **War Sign-up #${st.warId}** in <#${ch.id}>.`);
        return;
      }
    }

    // modals
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'wb:opp:modal') {
        const st = wiz.get(interaction.user.id);
        if (!st) return;
        st.opponent = interaction.fields.getTextInputValue('opp').trim();
        const ready = canCreate(st);

        // try to edit the wizard message (it might be gone if redeployed)
        try {
          const ch = await client.channels.fetch(st.channelId);
          const msg = await ch.messages.fetch(st.wizardMessageId);
          await msg.edit({
            content: `🧭 **War Setup** — **War ID ${st.warId}**\n${summary(st)}`,
            components: [teamSizeMenu(st.teamSize), formatMenu(st.format), dateMenu(st.dateISO), timeMenu(st.timeValue), opponentButtons(!!st.opponent, ready)]
          });
        } catch {}
        await safeEphemeral(interaction, '✅ Opponent set.');
        return;
      }
    }
  } catch (e) {
    console.error('INTERACTION ERROR:', e);
    try {
      if (interaction.isRepliable?.()) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '⚠️ Something went wrong.', flags: 1 << 6 });
        }
      }
    } catch {}
  }
});

/* ------------------------ reaction tracking ------------------------------ */
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

/* -------------------------------- boot ----------------------------------- */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await initSheets().catch(e => console.error('initSheets error:', e));
  initDB();
  await registerCommands().catch(e => console.error('registerCommands error:', e));
});
client.login(process.env.DISCORD_TOKEN);

// index.js — Fresh minimal build with Paged Time Picker (24 options/page) + War ID + 👍/👎/🛑 + Sheets

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

// ---------- Render compatibility: bind only if PORT is provided ----------
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

// ---------- In-memory state ----------
/** wizardState[userId] = { warId, teamSize, format, opponent, startET, timePage } */
const wizardState = new Map();
/** pools[msgId] = { warId, signups: Map<userId, {name, tsMs}>, declines: Map<userId, {name, tsMs}> } */
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

function nextHalfHourET() {
  const now = new Date();
  // round up to next :00 or :30 in *UTC time*, we'll format in ET for display
  const d = new Date(now.getTime());
  const m = d.getMinutes();
  d.setMinutes(m < 30 ? 30 : 60, 0, 0);
  return d;
}

function slotLabelET(date) {
  return date.toLocaleString('en-US', {
    weekday: 'short', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/New_York',
  }) + ' ET';
}

/**
 * Build 24 half-hour slots for a given page.
 * page 0 = next 12 hours, page 1 = hours 12–24, ... up to page 5 (total 72h).
 */
function buildTimeChoicesPage(page = 0) {
  const out = [];
  const start = nextHalfHourET();
  const pageStart = new Date(start.getTime() + page * 12 * 60 * 60 * 1000); // + N * 12h
  for (let i = 0; i < 24; i++) {
    const t = new Date(pageStart.getTime() + i * 30 * 60 * 1000);
    const label = slotLabelET(t);
    out.push({ label, value: String(t.getTime()) }); // store ms since epoch as value
  }
  return out;
}

// sticky components
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
function timeMenu(page = 0, selectedValue = null) {
  const opts = buildTimeChoicesPage(page).map(({ label, value }) => ({
    label, value, default: selectedValue === value
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wb:w:time')
      .setPlaceholder(`Pick a start time (ET) — Page ${page + 1}/6`)
      .addOptions(...opts)
  );
}
function timePager(page = 0) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wb:w:tprev').setLabel('◀ Prev 12h').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId('wb:w:tnext').setLabel('Next 12h ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= 5),
  );
}
function navButtons(nextEnabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wb:w:next').setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(!nextEnabled),
    new ButtonBuilder().setCustomId('wb:w:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}

// pretty list
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
        // 1) get a War ID
        let warId = await getNextWarId().catch(() => null);
        if (!Number.isInteger(warId)) {
          const n = new Date();
          warId = Number(`${n.getUTCFullYear()}${String(n.getUTCMonth()+1).padStart(2,'0')}${String(n.getUTCDate()).padStart(2,'0')}${String(n.getUTCHours()).padStart(2,'0')}${String(n.getUTCMinutes()).padStart(2,'0')}`);
        }
        wizardState.set(interaction.user.id, { warId, teamSize: null, format: null, opponent: null, startET: null, timePage: 0 });

        await interaction.reply({
          content:
            `🧭 **War Wizard** — **War ID ${warId}**\n` +
            `1) Choose **Team Size**\n2) Choose **Format**\n3) Enter **Opponent** & **Start Time**\n\n` +
            `Your selections will remain visible below.`,
          components: [teamSizeMenu(null), formatMenu(null), navButtons(false)],
          flags: 1 << 6, // ephemeral
        });
        return;
      }

      if (sub === 'cancel') {
        const warId = interaction.options.getInteger('war_id', true);
        const messageId = warToMessage.get(String(warId));
        if (!messageId) {
          await interaction.reply({ content: `❌ I can’t find a live sign-up for War ID ${warId}.`, flags: 1 << 6 });
          return;
        }
        const ch = await client.channels.fetch(process.env.WAR_CHANNEL_ID).catch(()=>null);
        const msg = ch ? await ch.messages.fetch(messageId).catch(()=>null) : null;
        if (msg) await msg.delete().catch(()=>{});
        warToMessage.delete(String(warId));
        for (const [mid] of pools) if (mid === messageId) pools.delete(mid);
        await interaction.reply({ content: `🛑 War Sign-up #${warId} has been cancelled.`, flags: 1 << 6 });
        return;
      }
    }

    // --- wizard dropdowns
    if (interaction.isStringSelectMenu()) {
      const st = wizardState.get(interaction.user.id);
      if (!st) return;

      if (interaction.customId === 'wb:w:size') {
        st.teamSize = interaction.values[0];
        await interaction.update({
          content: `🧭 **War Wizard** — **War ID ${st.warId}**\nTeam Size: **${st.teamSize || '—'}** | Format: **${st.format || '—'}**\nSelect both, then click **Next**.`,
          components: [teamSizeMenu(st.teamSize), formatMenu(st.format), navButtons(!!(st.teamSize && st.format))],
        });
        return;
      }
      if (interaction.customId === 'wb:w:format') {
        st.format = interaction.values[0];
        await interaction.update({
          content: `🧭 **War Wizard** — **War ID ${st.warId}**\nTeam Size: **${st.teamSize || '—'}** | Format: **${st.format || '—'}**\nSelect both, then click **Next**.`,
          components: [teamSizeMenu(st.teamSize), formatMenu(st.format), navButtons(!!(st.teamSize && st.format))],
        });
        return;
      }
      if (interaction.customId === 'wb:w:time') {
        const val = interaction.values[0]; // ms since epoch we stored
        st.startET = slotLabelET(new Date(Number(val)));
        await interaction.update({
          content: `🧭 **War Wizard** — **War ID ${st.warId}**\nOpponent: **${st.opponent || '—'}**\nStart (ET): **${st.startET || '—'}**\nClick **Create Sign-up** to post or change the page/time below.`,
          components: [
            timeMenu(st.timePage, String(val)),
            timePager(st.timePage),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('wb:w:create').setLabel('Create Sign-up').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId('wb:w:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
        return;
      }
    }

    // --- wizard buttons & modal
    if (interaction.isButton()) {
      const st = wizardState.get(interaction.user.id);

      if (interaction.customId === 'wb:w:cancel') {
        wizardState.delete(interaction.user.id);
        await interaction.update({ content: '❌ Wizard cancelled.', components: [] });
        return;
      }

      if (interaction.customId === 'wb:w:next') {
        if (!st || !st.teamSize || !st.format) {
          await interaction.reply({ content: 'Please choose team size and format first.', flags: 1 << 6 });
          return;
        }
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

      if (interaction.customId === 'wb:w:tprev' || interaction.customId === 'wb:w:tnext') {
        if (!st || !st.opponent) {
          await interaction.reply({ content: 'Enter an opponent first.', flags: 1 << 6 });
          return;
        }
        if (interaction.customId === 'wb:w:tprev' && st.timePage > 0) st.timePage -= 1;
        if (interaction.customId === 'wb:w:tnext' && st.timePage < 5) st.timePage += 1;
        await interaction.update({
          content: `🧭 **War Wizard** — **War ID ${st.warId}**\nOpponent: **${st.opponent}**\nStart (ET): **${st.startET || '—'}**\nPick a time below (Page ${st.timePage+1}/6).`,
          components: [
            timeMenu(st.timePage, null),
            timePager(st.timePage),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('wb:w:create').setLabel('Create Sign-up').setStyle(ButtonStyle.Success).setDisabled(!st.startET),
              new ButtonBuilder().setCustomId('wb:w:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
        return;
      }

      if (interaction.customId === 'wb:w:create') {
        if (!st || !st.opponent || !st.startET) {
          await interaction.reply({ content: 'Please enter opponent and pick a start time first.', flags: 1 << 6 });
          return;
        }
        const chId = process.env.WAR_CHANNEL_ID;
        const ch = chId ? await client.channels.fetch(chId).catch(()=>null) : null;
        if (!ch || !ch.isTextBased()) {
          await interaction.reply({ content: '❌ WAR_CHANNEL_ID is missing or invalid.', flags: 1 << 6 });
          return;
        }

        // Create embed
        let embed = {
          title: `War Sign-up #${st.warId}`,
          description:
            `**War ID:** ${st.warId}\n` +
            `**Opponent:** ${st.opponent}\n` +
            `**Format:** ${st.format}\n` +
            `**Team Size:** ${st.teamSize}v${st.teamSize}\n` +
            `**Start (ET):** ${st.startET}\n\n` +
            `React 👍 to **join** (timestamp recorded).\nReact 👎 if you **cannot** play (opt-out).\nReact 🛑 to **cancel** this sign-up.`,
          footer: { text: `War #${st.warId}` }
        };
        embed = embedWithWarId(embed, st.warId);

        const msg = await ch.send({ embeds: [embed] });
        warToMessage.set(String(st.warId), msg.id);
        pools.set(msg.id, { warId: st.warId, signups: new Map(), declines: new Map() });

        // Write to Sheets (war created)
        pushWarCreated({
          warId: st.warId,
          opponent: st.opponent,
          format: st.format,
          teamSize: st.teamSize,
          startET: st.startET,
          channelId: ch.id,
          messageId: msg.id,
        }).catch(e => console.error('pushWarCreated error:', e));

        // Reacts
        await msg.react('👍').catch(()=>{});
        await msg.react('👎').catch(()=>{});
        await msg.react('🛑').catch(()=>{});

        await interaction.update({
          content:
            `✅ **War Sign-up #${st.warId}** created in <#${ch.id}>.\n` +
            `Opponent: **${st.opponent}** | Format: **${st.format}** | Team: **${st.teamSize}v${st.teamSize}** | Start: **${st.startET}**`,
          components: [],
        });
        wizardState.delete(interaction.user.id);
        return;
      }
    }

    // Opponent modal submit
    if (interaction.isModalSubmit() && interaction.customId === 'wb:w:oppmodal') {
      const st = wizardState.get(interaction.user.id);
      if (!st) return;
      st.opponent = interaction.fields.getTextInputValue('wb:w:opptxt');
      st.timePage = 0; // start at first page
      await interaction.reply({
        content: `🧭 **War Wizard** — **War ID ${st.warId}**\nOpponent: **${st.opponent}**\nPick a **Start Time (ET)** below (Page 1/6).`,
        components: [
          timeMenu(0, null),
          timePager(0),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('wb:w:create').setLabel('Create Sign-up').setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId('wb:w:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
        flags: 1 << 6,
      });
      return;
    }

  } catch (e) {
    console.error('INTERACTION ERROR:', e);
    try {
      if (interaction.isRepliable?.()) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '⚠️ Something went wrong.', flags: 1 << 6 });
        } else {
          await interaction.editReply?.({ content: '⚠️ Something went wrong.' });
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

  // Remove old blocks and append fresh blocks
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
  initDB(); // no-op today; here for future stats
  await registerCommands();
});

client.login(process.env.DISCORD_TOKEN);

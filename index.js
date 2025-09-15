// index.js — stable wizard with single ephemeral message + stop-sign cancel
import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials,
  REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle,
  EmbedBuilder, MessageFlagsBitField,
} from 'discord.js';

const {
  DISCORD_TOKEN,
  GUILD_ID,
  WAR_CHANNEL_ID,
  PING_ROLE_ID, // optional role to ping on sign-up creation
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !WAR_CHANNEL_ID) {
  console.error('❌ Missing env: DISCORD_TOKEN, GUILD_ID, WAR_CHANNEL_ID');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});

const EPHEMERAL = MessageFlagsBitField.Flags.Ephemeral;

// ---------- State ----------
/** per-user wizard state */
const wiz = new Map();
/** simple in-memory War IDs (replace with DB later if you want persistence) */
let nextWarId = 1;

// ---------- Static choices ----------
const TEAM_SIZES = ['6v6','7v7','8v8'];
const FORMATS   = ['BO3','BO5'];
const TIME_OPTIONS = [
  '4:30 PM ET','5:00 PM ET','5:30 PM ET',
  '6:00 PM ET','6:30 PM ET','7:00 PM ET','7:30 PM ET',
  '8:00 PM ET','8:30 PM ET','9:00 PM ET','9:30 PM ET',
  '10:00 PM ET','10:30 PM ET','11:00 PM ET','11:30 PM ET',
  'SUPERLATENIGHT',
];

function todayPlus(n) { const d = new Date(); d.setDate(d.getDate()+n); return d; }
function dateISO(d){ return d.toISOString().slice(0,10); }
function dateLabel(d){
  return d.toLocaleDateString('en-US',{ weekday:'short', month:'short', day:'numeric' });
}
function summary(st){
  return [
    `War ID: **${st.warId}**`,
    `Opponent: **${st.opponent || '—'}**`,
    `Team: **${st.teamSize || '—'}**`,
    `Format: **${st.format || '—'}**`,
    `Date: **${st.dateLabel || '—'}**`,
    `Time: **${st.timeLabel || '—'}**`,
  ].join(' | ');
}

// ---------- Components ----------
function teamMenu(sel){
  const m = new StringSelectMenuBuilder()
    .setCustomId('wb:team')
    .setPlaceholder('Select team size')
    .addOptions(TEAM_SIZES.map(v=>({label:v,value:v,default:v===sel})));
  return new ActionRowBuilder().addComponents(m);
}
function fmtMenu(sel){
  const m = new StringSelectMenuBuilder()
    .setCustomId('wb:fmt')
    .setPlaceholder('Select format')
    .addOptions(FORMATS.map(v=>({label: v==='BO3'?'Best of 3':'Best of 5', value:v, default:v===sel})));
  return new ActionRowBuilder().addComponents(m);
}
function dateMenu(selISO){
  const opts = Array.from({length:7},(_,i)=>{
    const d = todayPlus(i); const iso = dateISO(d);
    return { label: dateLabel(d), value: iso, default: iso===selISO };
  });
  const m = new StringSelectMenuBuilder()
    .setCustomId('wb:date')
    .setPlaceholder('Pick date (next 7 days)')
    .addOptions(opts);
  return new ActionRowBuilder().addComponents(m);
}
function timeMenu(sel){
  const m = new StringSelectMenuBuilder()
    .setCustomId('wb:time')
    .setPlaceholder('Pick time (ET) — 4:30 PM to 11:30 PM')
    .addOptions(TIME_OPTIONS.map(t=>({label:t,value:t,default:t===sel})));
  return new ActionRowBuilder().addComponents(m);
}
function actionRow(canCreate){
  const setOpp = new ButtonBuilder()
    .setCustomId('wb:opp')
    .setStyle(ButtonStyle.Primary)
    .setLabel('Set Opponent');

  const create = new ButtonBuilder()
    .setCustomId('wb:create')
    .setStyle(ButtonStyle.Success)
    .setLabel('Create Sign-up')
    .setDisabled(!canCreate);

  const cancel = new ButtonBuilder()
    .setCustomId('wb:cancel')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('🛑')
    .setLabel('Cancel');

  return new ActionRowBuilder().addComponents(setOpp, create, cancel);
}
function components(st){
  const ready = !!(st.opponent && st.teamSize && st.format && st.dateLabel && st.timeLabel);
  return [teamMenu(st.teamSize), fmtMenu(st.format), dateMenu(st.dateISO), timeMenu(st.timeLabel), actionRow(ready)];
}
function opponentModal(){
  return new ModalBuilder()
    .setCustomId('wb:opp:modal')
    .setTitle('Opponent')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('opp')
          .setLabel('Enter opponent name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64),
      ),
    );
}

// ---------- Slash command ----------
const commands = [{
  name: 'warbot',
  description: 'WarBot commands',
  options: [{ type: 1, name: 'new', description: 'Create a new War Sign-up (wizard)' }],
}];

async function registerCommands(){
  const rest = new REST({version:'10'}).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log('✅ Registered /warbot commands');
}

// ---------- Posting the sign-up ----------
async function postSignup(st){
  const channel = await client.channels.fetch(WAR_CHANNEL_ID);
  if (!channel?.isTextBased()) throw new Error('Invalid WAR_CHANNEL_ID');

  const embed = new EmbedBuilder()
    .setTitle(`War Sign-up — War #${st.warId}`)
    .setDescription([
      `**Opponent:** ${st.opponent}`,
      `**Team:** ${st.teamSize}`,
      `**Format:** ${st.format}`,
      `**Start (ET):** ${st.dateLabel}, ${st.timeLabel}`,
      '',
      'React 👍 to join. Unreact 👍 to drop out.',
      'React 👎 if you are not available.',
      'React 🛑 to cancel the war (admins/keepers/captains only).',
    ].join('\n'))
    .setColor(0x2b2d31);

  const content = PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : undefined;
  const msg = await channel.send({ content, embeds: [embed] });

  // seed reactions
  try { await msg.react('👍'); } catch {}
  try { await msg.react('👎'); } catch {}
  try { await msg.react('🛑'); } catch {}

  return msg.id;
}

// ---------- Client lifecycle ----------
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch {}
});

// ---------- Interaction handling ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // /warbot new
    if (interaction.isChatInputCommand() && interaction.commandName === 'warbot' && interaction.options.getSubcommand() === 'new') {
      const st = {
        root: interaction, // keep original interaction so we can edit the SAME ephemeral later
        warId: nextWarId++,
        opponent: '',
        teamSize: '6v6',
        format: 'BO3',
        dateISO: dateISO(todayPlus(0)),
        dateLabel: dateLabel(todayPlus(0)),
        timeLabel: '4:30 PM ET',
      };
      wiz.set(interaction.user.id, st);

      await interaction.reply({
        content: `🧭 **War Setup — War ID ${st.warId}**\n${summary(st)}`,
        components: components(st),
        flags: EPHEMERAL,
      });
      return;
    }

    // Dropdowns (these come from the same message, so we can update in-place)
    if (interaction.isStringSelectMenu()) {
      const st = wiz.get(interaction.user.id);
      if (!st) return;

      if (interaction.customId === 'wb:team') st.teamSize = interaction.values[0];
      if (interaction.customId === 'wb:fmt')  st.format   = interaction.values[0];
      if (interaction.customId === 'wb:date') {
        st.dateISO = interaction.values[0];
        const [y,m,d] = st.dateISO.split('-').map(Number);
        st.dateLabel = dateLabel(new Date(Date.UTC(y, m-1, d)));
      }
      if (interaction.customId === 'wb:time') st.timeLabel = interaction.values[0];

      await interaction.update({
        content: `🧭 **War Setup — War ID ${st.warId}**\n${summary(st)}`,
        components: components(st),
        flags: EPHEMERAL,
      });
      return;
    }

    // Buttons
    if (interaction.isButton()) {
      const st = wiz.get(interaction.user.id);
      if (!st) return;

      if (interaction.customId === 'wb:cancel') {
        wiz.delete(interaction.user.id);
        await interaction.reply({ content: '🛑 Wizard cancelled.', flags: EPHEMERAL });
        return;
      }

      if (interaction.customId === 'wb:opp') {
        // Important: do NOT defer; show the modal immediately
        await interaction.showModal(opponentModal());
        return;
      }

      if (interaction.customId === 'wb:create') {
        const ready = !!(st.opponent && st.teamSize && st.format && st.dateLabel && st.timeLabel);
        if (!ready) {
          await interaction.reply({ content: '❌ Please complete all fields first.', flags: EPHEMERAL });
          return;
        }

        const msgId = await postSignup(st);
        wiz.delete(interaction.user.id);
        await interaction.reply({
          content: `✅ Sign-up posted in <#${WAR_CHANNEL_ID}> (message \`${msgId}\`).`,
          flags: EPHEMERAL,
        });
        return;
      }
    }

    // Opponent modal submit
    if (interaction.isModalSubmit() && interaction.customId === 'wb:opp:modal') {
      const st = wiz.get(interaction.user.id);
      if (!st) return;

      st.opponent = interaction.fields.getTextInputValue('opp').trim();

      // Acknowledge the modal *and* edit the ORIGINAL wizard (no duplicate wizard views)
      await interaction.reply({ content: '✅ Opponent set.', flags: EPHEMERAL });

      try {
        await st.root.editReply({
          content: `🧭 **War Setup — War ID ${st.warId}**\n${summary(st)}`,
          components: components(st),
        });
      } catch (e) {
        // Fallback: if edit fails for any reason, send a fresh wizard once
        await interaction.followUp({
          content: `🧭 **War Setup — War ID ${st.warId}**\n${summary(st)}\n_(opened a new wizard view because the old one could not be edited)_`,
          components: components(st),
          flags: EPHEMERAL,
        });
        // and update the root reference to allow future edits
        st.root = interaction;
      }
      return;
    }

  } catch (err) {
    console.error('INTERACTION ERROR:', err);
    try {
      if (interaction && !interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: '⚠️ Something went wrong. Try again.', flags: EPHEMERAL });
      }
    } catch {}
  }
});

client.login(DISCORD_TOKEN).then(async () => {
  try { await registerCommands(); } catch {}
  console.log('✅ Google Sheets ready'); // keeps your logs familiar
}).catch((e)=>{
  console.error('Login failed:', e);
  process.exit(1);
});

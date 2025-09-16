// index.js — stable wizard + live signup list with timestamps
import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials,
  REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle,
  EmbedBuilder, MessageFlagsBitField, PermissionsBitField,
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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel, Partials.User, Partials.GuildMember],
});

const EPHEMERAL = MessageFlagsBitField.Flags.Ephemeral;

// ---------- State ----------
/** per-user wizard state */
const wiz = new Map();
/** simple in-memory War IDs */
let nextWarId = 1;
/** live signup states keyed by message id */
const signups = new Map(); // msgId -> { warId, teamSizeNum, opponent, format, dateLabel, timeLabel, users: Map<userId,{name,ts}>, backs: Set<userId>, notAvail:Set<userId> }

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

function sizeNum(str){ const m = String(str||'').match(/^(\d+)/); return m?parseInt(m[1],10):6; }
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

// ---------- Render sign-up embed with live lists ----------
function renderSignupEmbed(state){
  const starters = [];
  const backups  = [];
  const teamCap = state.teamSizeNum;

  // Sort users by join time
  const ordered = Array.from(state.users.entries())
    .sort((a,b)=>a[1].ts - b[1].ts);

  ordered.forEach(([uid, info], idx)=>{
    const line = `• ${info.name} — <t:${info.ts}:t>`;
    if (idx < teamCap) starters.push(line);
    else backups.push(line);
  });

  const notAvail = Array.from(state.notAvail || []).map(uid=>{
    const u = state.users.get(uid);
    const name = u?.name || `User ${uid}`;
    const ts = u?.ts || Math.floor(Date.now()/1000);
    return `• ${name} — <t:${ts}:t>`;
  });

  const desc = [
    `**Opponent:** ${state.opponent}`,
    `**Team:** ${state.teamSizeNum}v${state.teamSizeNum}`,
    `**Format:** ${state.format}`,
    `**Start (ET):** ${state.dateLabel}, ${state.timeLabel}`,
    '',
    'React 👍 to join. Unreact 👍 to drop out.',
    'React 👎 if you are not available.',
    'React 🛑 to cancel the war (admins/keepers/captains only).',
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`War Sign-up — War #${state.warId}`)
    .setDescription(desc)
    .addFields(
      { name: `Starters (${Math.min(starters.length, teamCap)}/${teamCap})`, value: starters.length? starters.join('\n') : '—', inline: false },
      { name: `Backups (${Math.max(0, backups.length)})`, value: backups.length? backups.join('\n') : '—', inline: false },
      { name: `Not Available (${notAvail.length})`, value: notAvail.length? notAvail.join('\n') : '—', inline: false },
    )
    .setColor(0x2b2d31);

  return embed;
}

// ---------- Posting the sign-up ----------
async function postSignup(st){
  const channel = await client.channels.fetch(WAR_CHANNEL_ID);
  if (!channel?.isTextBased()) throw new Error('Invalid WAR_CHANNEL_ID');

  const state = {
    warId: st.warId,
    teamSizeNum: sizeNum(st.teamSize),
    opponent: st.opponent,
    format: st.format,
    dateLabel: st.dateLabel,
    timeLabel: st.timeLabel,
    users: new Map(),      // userId -> { name, ts }
    notAvail: new Set(),   // userIds that clicked 👎
  };

  const embed = renderSignupEmbed(state);
  const content = PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : undefined;
  const msg = await channel.send({ content, embeds: [embed] });

  // seed reactions
  try { await msg.react('👍'); } catch {}
  try { await msg.react('👎'); } catch {}
  try { await msg.react('🛑'); } catch {}

  // store state
  signups.set(msg.id, state);

  return msg.id;
}

// ---------- Helpers for reactions ----------
async function updateSignupMessage(message){
  const state = signups.get(message.id);
  if (!state) return;
  try{
    const embed = renderSignupEmbed(state);
    await message.edit({ embeds:[embed] });
  }catch(e){ console.error('edit failed:', e?.code || e); }
}

function isWarChannel(message){
  return message?.channelId === WAR_CHANNEL_ID;
}

// ---------- Client lifecycle ----------
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch {}
  console.log('✅ Google Sheets ready');
});

// ---------- Interaction handling ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // /warbot new
    if (interaction.isChatInputCommand() && interaction.commandName === 'warbot' && interaction.options.getSubcommand() === 'new') {
      const st = {
        root: interaction, // keep original interaction to edit the SAME ephemeral
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
        components: [teamMenu(st.teamSize), fmtMenu(st.format), dateMenu(st.dateISO), timeMenu(st.timeLabel), actionRow(false)],
        flags: EPHEMERAL,
      });
      return;
    }

    // Dropdown updates
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

      const ready = !!(st.opponent && st.teamSize && st.format && st.dateLabel && st.timeLabel);
      await interaction.update({
        content: `🧭 **War Setup — War ID ${st.warId}**\n${summary(st)}`,
        components: [teamMenu(st.teamSize), fmtMenu(st.format), dateMenu(st.dateISO), timeMenu(st.timeLabel), actionRow(ready)],
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

      // acknowledge + edit original ephemeral wizard (no duplication)
      await interaction.reply({ content: '✅ Opponent set.', flags: EPHEMERAL });
      try {
        const ready = !!(st.opponent && st.teamSize && st.format && st.dateLabel && st.timeLabel);
        await st.root.editReply({
          content: `🧭 **War Setup — War ID ${st.warId}**\n${summary(st)}`,
          components: [teamMenu(st.teamSize), fmtMenu(st.format), dateMenu(st.dateISO), timeMenu(st.timeLabel), actionRow(ready)],
        });
      } catch {
        // fallback in case original ephemeral is gone
        st.root = interaction;
        await interaction.followUp({
          content: `🧭 **War Setup — War ID ${st.warId}**\n${summary(st)}`,
          components: [teamMenu(st.teamSize), fmtMenu(st.format), dateMenu(st.dateISO), timeMenu(st.timeLabel), actionRow(true)],
          flags: EPHEMERAL,
        });
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

// ---------- Reactions for live sign-ups ----------
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(()=>{});
    const message = reaction.message;
    if (!isWarChannel(message)) return;
    const state = signups.get(message.id);
    if (!state) return;

    // normalize emoji
    const emoji = reaction.emoji.name;

    if (emoji === '👍') {
      state.notAvail.delete(user.id);
      if (!state.users.has(user.id)) {
        // fetch display name
        let name = user.username;
        try {
          const member = await message.guild.members.fetch(user.id);
          name = member?.displayName || user.username;
        } catch {}
        state.users.set(user.id, { name, ts: Math.floor(Date.now()/1000) });
      }
      await updateSignupMessage(message);
    }
    if (emoji === '👎') {
      // mark not available
      if (!state.users.has(user.id)) {
        let name = user.username;
        try {
          const member = await message.guild.members.fetch(user.id);
          name = member?.displayName || user.username;
        } catch {}
        state.users.set(user.id, { name, ts: Math.floor(Date.now()/1000) });
      }
      state.notAvail.add(user.id);
      await updateSignupMessage(message);
    }
    if (emoji === '🛑') {
      // Only allow if the user has ManageMessages or is admin
      try {
        const member = await message.guild.members.fetch(user.id);
        const can = member.permissions.has(PermissionsBitField.Flags.ManageMessages) || member.permissions.has(PermissionsBitField.Flags.Administrator);
        if (can) {
          await message.delete().catch(()=>{});
          signups.delete(message.id);
        } else {
          // remove their stop reaction silently
          await reaction.users.remove(user.id).catch(()=>{});
        }
      } catch {}
    }
  } catch (e) {
    console.error('reactionAdd err:', e?.code || e);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(()=>{});
    const message = reaction.message;
    if (!isWarChannel(message)) return;
    const state = signups.get(message.id);
    if (!state) return;

    const emoji = reaction.emoji.name;

    if (emoji === '👍') {
      // drop from users (and from notAvail just in case)
      state.users.delete(user.id);
      state.notAvail.delete(user.id);
      await updateSignupMessage(message);
    }
    if (emoji === '👎') {
      state.notAvail.delete(user.id);
      await updateSignupMessage(message);
    }
  } catch (e) {
    console.error('reactionRemove err:', e?.code || e);
  }
});

client.login(DISCORD_TOKEN).catch((e)=>{
  console.error('Login failed:', e);
  process.exit(1);
});

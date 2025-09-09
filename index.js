// index.js — WarBot (production): manual roster picker + auto-pick + rich DMs + drop-after-lock handling
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
  Events,
} from 'discord.js';

import { initDB, getMaxWarId } from './db.js';          // safe no-op if you haven't wired persistence yet
import { initSheets } from './sheets.js';  // safe no-op if you use a stub; keeps creds checked

initDB();
let nextWarId = await getMaxWarId();

/* ============== IN-MEMORY STATE ============== */
const wars = new Map(); // messageId -> war
let nextWarId = 1;
/*
war = { 
  id: number,
  channelId: string,
  teamSize: number,
  pool: Map<userId, { name, joinedISO }>,
  starters: string[],
  backups: string[],
  locked: boolean,
  meta: { opponent, format, startET },
}
*/

const newWizard = new Map(); // userId -> { teamSize, format, opponent? }

/* ============== DISCORD CLIENT ============== */
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

const isAdminish = (member) => {
  if (!member) return false;
  const roles = new Set(member.roles.cache.map((r) => r.id));
  const allowed = [
    process.env.ROLE_ADMIN,
    process.env.ROLE_MANAGER,
    process.env.ROLE_KEEPER,
    process.env.ROLE_CAPTAIN,
  ].filter(Boolean);
  return (
    allowed.some((id) => roles.has(id)) ||
    member.permissions.has(PermissionsBitField.Flags.Administrator)
  );
};

/* ============== UTILITIES ============== */
function sortedPoolArray(war) {
  return [...war.pool.entries()]
    .sort((a, b) => new Date(a[1].joinedISO) - new Date(b[1].joinedISO))
    .map(([userId, p]) => ({ userId, ...p }));
}
function listWithTimes(war) {
  const arr = sortedPoolArray(war);
  if (!arr.length) return 'No one yet.';
  return arr
    .map((p, i) => `${i + 1}. ${p.name} — <t:${Math.floor(new Date(p.joinedISO).getTime() / 1000)}:t>`)
    .join('\n');
}
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
async function updateSignupEmbed(msg) {
  const war = wars.get(msg.id);
  if (!war) return;
  const base = msg.embeds?.[0];
const embed = base ? EmbedBuilder.from(base) : new EmbedBuilder().setColor(0x2ecc71);
  embed.setTitle(`War Sign-up #${war.id}`);

    const startersText = war.starters?.length
    ? war.starters.map((id) => war.pool.get(id)?.name ?? `User ${id}`).join(', ')
    : '—';
  const backupsText = war.backups?.length
    ? war.backups.map((id) => war.pool.get(id)?.name ?? `User ${id}`).join(', ')
    : '—';

  embed.setFields(
    { name: `Starters (${war.starters?.length || 0}/${war.teamSize})`, value: startersText },
    { name: `Backups (${war.backups?.length || 0})`, value: backupsText },
    { name: 'Sign-ups', value: listWithTimes(war) }
  );
  embed.setFooter({ text: war.locked ? 'Roster locked' : 'Roster open' });

  await msg.edit({ embeds: [embed] });
}
async function findLatestWarMessageInChannel(channel) {
  const msgs = await channel.messages.fetch({ limit: 50 });
  return msgs.find((m) => wars.has(m.id));
}

async function findWarMessageInChannelById(channel, warId) {
  for (const [msgId, war] of wars.entries()) {
    if (war.id === warId && war.channelId === channel.id) {
      return channel.messages.fetch(msgId).catch(() => null);
    }
  }
  return null;
}

/* ============== COMMANDS ============== */
async function registerCommands() {
  const commands = [
    {
      name: 'warbot',
      description: 'WarBot commands',
      options: [
        { type: 1, name: 'new', description: 'Create a new War Sign-up (dropdowns)' },
        {
          type: 1,
          name: 'select',
          description: 'Pick roster (manual or auto-pick)',
          options: [{ type: 4, name: 'war', description: 'War ID', required: false }],
        },
        { type: 1, name: 'help', description: 'Show WarBot help and quick reference' },
        {
          type: 1,
          name: 'simulate',
          description: 'Admin: seed 10 fake signups (testing only)',
          options: [{ type: 4, name: 'war', description: 'War ID', required: false }],
        },
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

/* ============== READY ============== */
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await initSheets();
  await registerCommands();
});

/* ============== INTERACTIONS ============== */
client.on('interactionCreate', async (interaction) => {
  try {
    /* ---------- SLASH ---------- */
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'warbot') return;
      const sub = interaction.options.getSubcommand();

      // HELP
      if (sub === 'help') {
        const embed = new EmbedBuilder()
          .setTitle('WarBot — Quick Reference')
          .setColor(0x5865f2)
          .setDescription(
            [
              '**Users**',
              '• React 👍 to sign up; unreact to drop out.\n• You will be DM’d if selected as **starter** or **backup**.',
              '',
              '**Admins / Managers / Captains**',
              '• `/warbot new` → dropdowns for team size & format → opponent → time.',
              '• `/warbot select [war]` → **Manual Pick** or **Auto-pick First N**; DMs go out; embed updates.',
              '• If a starter drops after lock, roster unlocks and admins are pinged to re-select.',
              '',
              '**Cancel**',
              '• React 🛑 on the sign-up (admins only) to cancel & delete the post.',
            ].join('\n')
          );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('help:full').setLabel('Show full tutorial (DM)').setStyle(ButtonStyle.Primary)
        );
        return interaction.reply({ ephemeral: true, embeds: [embed], components: [row] });
      }

      // SIMULATE
      if (sub === 'simulate') {
        if (!isAdminish(interaction.member)) {
          return interaction.reply({ ephemeral: true, content: 'No permission.' });
        }
        const idOpt = interaction.options.getInteger('war');
        const warMsg = idOpt
          ? await findWarMessageInChannelById(interaction.channel, idOpt)
          : await findLatestWarMessageInChannel(interaction.channel);
        if (!warMsg) {
          return interaction.reply({ ephemeral: true, content: 'No active War Sign-up here. Run /warbot new first.' });
        }
        const war = wars.get(warMsg.id);
        const already = war.pool.size;
        for (let i = 1; i <= 10; i++) {
          const fakeId = `9990000000000${String(i).padStart(2, '0')}`;
          if (!war.pool.has(fakeId)) {
            war.pool.set(fakeId, { name: `FakeUser${i}`, joinedISO: new Date(Date.now() + i * 500).toISOString() });
          }
        }
        await updateSignupEmbed(warMsg);
        if (war.pool.size >= war.teamSize && !war.locked && process.env.ADMIN_PING_ROLE_ID) {
          await interaction.channel.send({ content: `<@&${process.env.ADMIN_PING_ROLE_ID}> ${war.teamSize}+ signed up (simulation).` });
        }
        return interaction.reply({ ephemeral: true, content: `✅ Seeded ${war.pool.size - already} fake signups (now ${war.pool.size} in pool).` });
      }

      // NEW (dropdown wizard)
      if (sub === 'new') {
        if (!isAdminish(interaction.member)) {
          return interaction.reply({ ephemeral: true, content: 'You do not have permission to create wars.' });
        }
        newWizard.set(interaction.user.id, { teamSize: null, format: null, opponent: null });

        const sizeSelect = new StringSelectMenuBuilder()
          .setCustomId('new:size')
          .setPlaceholder('Select team size')
          .addOptions({ label: '6v6', value: '6' }, { label: '7v7', value: '7' }, { label: '8v8', value: '8' });

        const formatSelect = new StringSelectMenuBuilder()
          .setCustomId('new:format')
          .setPlaceholder('Select format')
          .addOptions({ label: 'Best of 3', value: 'bo3' }, { label: 'Best of 5', value: 'bo5' });

        const nextBtn = new ButtonBuilder()
          .setCustomId('new:next')
          .setLabel('Next: Opponent & Time')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(true);

        return interaction.reply({
          ephemeral: true,
          content: 'Set up your War Sign-up:',
          components: [
            new ActionRowBuilder().addComponents(sizeSelect),
            new ActionRowBuilder().addComponents(formatSelect),
            new ActionRowBuilder().addComponents(nextBtn),
          ],
        });
      }

      // SELECT (present options)
      if (sub === 'select') {
        if (!isAdminish(interaction.member)) {
          return interaction.reply({ ephemeral: true, content: 'No permission.' });
        }
        const idOpt = interaction.options.getInteger('war');
        const warMsg = idOpt
          ? await findWarMessageInChannelById(interaction.channel, idOpt)
          : await findLatestWarMessageInChannel(interaction.channel);
        if (!warMsg) {
          return interaction.reply({ ephemeral: true, content: 'No War Sign-up found in this channel.' });
        }
        const war = wars.get(warMsg.id);
        const poolArr = sortedPoolArray(war);
        if (poolArr.length < war.teamSize) {
          return interaction.reply({ ephemeral: true, content: `Need at least ${war.teamSize} sign-ups (currently ${poolArr.length}).` });
        }

        // Controls: manual or auto
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`select:auto:${warMsg.id}`)
            .setLabel(`Auto-pick First ${war.teamSize}`)
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`select:manual:${warMsg.id}`).setLabel('Manual Pick').setStyle(ButtonStyle.Primary)
        );
        return interaction.reply({ ephemeral: true, content: 'Choose how to select the roster:', components: [row] });
      }
    }

    /* ---------- BUTTONS ---------- */
    if (interaction.isButton()) {
      // Help → DM
      if (interaction.customId === 'help:full') {
        const longText =
          '📖 **WarBot Full Tutorial**\n\n' +
          '1) `/warbot new` → choose team size & format, enter opponent, pick time.\n' +
          '2) Players react 👍 to join; unreact to drop.\n' +
          '3) `/warbot select [war]` → Manual Pick or Auto-pick; DMs go out; embed updates.\n' +
          '4) If a starter drops after lock, admins are pinged to re-select; if no backups, recruitment is pinged.\n' +
          '5) 🛑 on the sign-up (admins) cancels & deletes.';
        try {
          await interaction.user.send(longText);
          return interaction.reply({ ephemeral: true, content: '📬 Sent you the full tutorial in DMs.' });
        } catch {
          return interaction.reply({ ephemeral: true, content: '❌ Could not DM you (DMs closed).' });
        }
      }

      // NEW → Next → Opponent modal
      if (interaction.customId === 'new:next') {
        const wiz = newWizard.get(interaction.user.id);
        if (!wiz || !wiz.teamSize || !wiz.format) {
          return interaction.reply({ ephemeral: true, content: 'Please select both Team Size and Format first.' });
        }
        const modal = new ModalBuilder().setCustomId('new:oppmodal').setTitle('Opponent Name');
        const oppInput = new TextInputBuilder().setCustomId('new:opp').setLabel('Opponent').setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(oppInput));
        return interaction.showModal(modal);
      }

      // SELECT → Auto-pick
      if (interaction.customId.startsWith('select:auto:')) {
        if (!isAdminish(interaction.member)) {
          return interaction.reply({ ephemeral: true, content: 'No permission.' });
        }
        const warMsgId = interaction.customId.split(':')[2];
        const channel = interaction.channel;
        const warMsg = await channel.messages.fetch(warMsgId).catch(() => null);
        if (!warMsg || !wars.has(warMsg.id)) {
          return interaction.reply({ ephemeral: true, content: 'War Sign-up not found.' });
        }
        const war = wars.get(warMsg.id);
        const poolArr = sortedPoolArray(war);
        war.starters = poolArr.slice(0, war.teamSize).map((p) => p.userId);
        war.backups = poolArr.slice(war.teamSize).map((p) => p.userId);
        war.locked = true;

        // DM real members
        for (const uid of war.starters) {
          interaction.guild.members.fetch(uid).then((m) => m.send(starterDM(war))).catch(() => {});
        }
        for (const uid of war.backups) {
          interaction.guild.members.fetch(uid).then((m) => m.send(backupDM(war))).catch(() => {});
        }

        await updateSignupEmbed(warMsg);
        return interaction.update({ content: `✅ Auto-picked ${war.teamSize} starters (${war.backups.length} backups). Roster locked.`, components: [] });
      }

      // SELECT → Manual Pick (show selector)
      if (interaction.customId.startsWith('select:manual:')) {
        if (!isAdminish(interaction.member)) {
          return interaction.reply({ ephemeral: true, content: 'No permission.' });
        }
        const warMsgId = interaction.customId.split(':')[2];
        const channel = interaction.channel;
        const warMsg = await channel.messages.fetch(warMsgId).catch(() => null);
        if (!warMsg || !wars.has(warMsg.id)) {
          return interaction.reply({ ephemeral: true, content: 'War Sign-up not found.' });
        }
        const war = wars.get(warMsg.id);
        const poolArr = sortedPoolArray(war);

        // Build options (≤ 25 supported; you said ≤ 20 total)
        const options = poolArr.slice(0, 25).map((p) => ({
          label: p.name,
          value: `${p.userId}`,
          description: `Joined ${new Date(p.joinedISO).toLocaleTimeString()}`,
        }));

        const select = new StringSelectMenuBuilder()
          .setCustomId(`select:pick:${warMsg.id}:${war.teamSize}`)
          .setPlaceholder(`Pick exactly ${war.teamSize} starters`)
          .setMinValues(war.teamSize)
          .setMaxValues(war.teamSize)
          .addOptions(options);

        const confirm = new ButtonBuilder()
          .setCustomId(`select:confirm:${warMsg.id}`)
          .setLabel('Confirm Roster')
          .setStyle(ButtonStyle.Success)
          .setDisabled(true); // enabled after selection arrives

        return interaction.update({
          content: `Select **${war.teamSize}** starters from the pool:`,
          components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(confirm)],
        });
      }

      // SELECT → Confirm Roster
      if (interaction.customId.startsWith('select:confirm:')) {
        if (!isAdminish(interaction.member)) {
          return interaction.reply({ ephemeral: true, content: 'No permission.' });
        }
        const warMsgId = interaction.customId.split(':')[2];
        const channel = interaction.channel;
        const warMsg = await channel.messages.fetch(warMsgId).catch(() => null);
        if (!warMsg || !wars.has(warMsg.id)) {
          return interaction.reply({ ephemeral: true, content: 'War Sign-up not found.' });
        }
        const war = wars.get(warMsg.id);
        if (!war._pendingStarters || war._pendingStarters.length !== war.teamSize) {
          return interaction.reply({ ephemeral: true, content: `Please pick exactly ${war.teamSize} starters first.` });
        }

        war.starters = [...war._pendingStarters];
        const poolArr = sortedPoolArray(war);
        const starterSet = new Set(war.starters);
        war.backups = poolArr.filter((p) => !starterSet.has(p.userId)).map((p) => p.userId);
        war.locked = true;
        delete war._pendingStarters;

        // DM real members
        for (const uid of war.starters) {
          interaction.guild.members.fetch(uid).then((m) => m.send(starterDM(war))).catch(() => {});
        }
        for (const uid of war.backups) {
          interaction.guild.members.fetch(uid).then((m) => m.send(backupDM(war))).catch(() => {});
        }

        await updateSignupEmbed(warMsg);
        return interaction.update({ content: `✅ Roster locked. Starters: ${war.starters.length}. Backups: ${war.backups.length}.`, components: [] });
      }
    }

    /* ---------- SELECT MENUS ---------- */
    if (interaction.isStringSelectMenu()) {
      // NEW → team size
      if (interaction.customId === 'new:size') {
        const wiz = newWizard.get(interaction.user.id) || {};
        wiz.teamSize = Number(interaction.values[0]);
        newWizard.set(interaction.user.id, wiz);
        const enableNext = Boolean(wiz.teamSize && wiz.format);
        const nextBtn = new ButtonBuilder().setCustomId('new:next').setLabel('Next: Opponent & Time').setStyle(ButtonStyle.Primary).setDisabled(!enableNext);
        const sizeSelect = new StringSelectMenuBuilder().setCustomId('new:size').setPlaceholder('Select team size').addOptions(
          { label: '6v6', value: '6' }, { label: '7v7', value: '7' }, { label: '8v8', value: '8' }
        );
        const formatSelect = new StringSelectMenuBuilder().setCustomId('new:format').setPlaceholder('Select format').addOptions(
          { label: 'Best of 3', value: 'bo3' }, { label: 'Best of 5', value: 'bo5' }
        );
        return interaction.update({
          components: [
            new ActionRowBuilder().addComponents(sizeSelect),
            new ActionRowBuilder().addComponents(formatSelect),
            new ActionRowBuilder().addComponents(nextBtn),
          ],
        });
      }
      // NEW → format
      if (interaction.customId === 'new:format') {
        const wiz = newWizard.get(interaction.user.id) || {};
        wiz.format = interaction.values[0];
        newWizard.set(interaction.user.id, wiz);
        const enableNext = Boolean(wiz.teamSize && wiz.format);
        const nextBtn = new ButtonBuilder().setCustomId('new:next').setLabel('Next: Opponent & Time').setStyle(ButtonStyle.Primary).setDisabled(!enableNext);
        const sizeSelect = new StringSelectMenuBuilder().setCustomId('new:size').setPlaceholder('Select team size').addOptions(
          { label: '6v6', value: '6' }, { label: '7v7', value: '7' }, { label: '8v8', value: '8' }
        );
        const formatSelect = new StringSelectMenuBuilder().setCustomId('new:format').setPlaceholder('Select format').addOptions(
          { label: 'Best of 3', value: 'bo3' }, { label: 'Best of 5', value: 'bo5' }
        );
        return interaction.update({
          components: [
            new ActionRowBuilder().addComponents(sizeSelect),
            new ActionRowBuilder().addComponents(formatSelect),
            new ActionRowBuilder().addComponents(nextBtn),
          ],
        });
      }

      // NEW → time (after modal)
      if (interaction.customId.startsWith('new:time:')) {
        const [, , sizeStr, fmt, oppEnc] = interaction.customId.split(':');
        const sizeNum = Number(sizeStr);
        const opp = decodeURIComponent(oppEnc);
        const iso = interaction.values[0];

        const warChannelId = process.env.WAR_CHANNEL_ID || interaction.channelId;
        const warChannel = interaction.guild.channels.cache.get(warChannelId) || interaction.channel;

        const startET = etString(iso);
        const description = [
          `**Opponent:** ${opp}`,
          `**Format:** ${fmt.toUpperCase()}`,
          `**Start (ET):** ${startET}`,
          '',
          'React 👍 to join. Unreact to drop out.',
        ].join('\n');

        const warId = nextWarId++;
        const embed = new EmbedBuilder()
          .setTitle(`War Sign-up #${warId}`)
          .setColor(0x2ecc71)
          .setDescription(description)
          .setFooter({ text: `Team size: ${sizeNum}v${sizeNum}` });
        const msg = await warChannel.send({ embeds: [embed] });        const msg = await warChannel.send({ embeds: [embed] });

        wars.set(msg.id, {
          id: nextWarId++,
          channelId: warChannel.id,
          teamSize: sizeNum,
          pool: new Map(),
          starters: [],
          backups: [],
          locked: false,
          meta: { opponent: opp, format: fmt, startET },
        });

        try { await msg.react('👍'); } catch {}
        try { await msg.react('🛑'); } catch {}

        newWizard.delete(interaction.user.id);
        return interaction.update({ content: `✅ Created sign-up in <#${warChannel.id}>.`, components: [] });
      }

      // SELECTOR: manual pick starters
      if (interaction.customId.startsWith('select:pick:')) {
        const [, , warMsgId, sizeStr] = interaction.customId.split(':');
        const teamSize = Number(sizeStr);
        const selected = interaction.values; // array of userIds
        // store pending starters on the war; confirm button enables now
        const channel = interaction.channel;
        const warMsg = await channel.messages.fetch(warMsgId).catch(() => null);
        if (!warMsg || !wars.has(warMsg.id)) {
          return interaction.reply({ ephemeral: true, content: 'War Sign-up not found.' });
        }
        const war = wars.get(warMsg.id);
        if (selected.length !== teamSize) {
          return interaction.reply({ ephemeral: true, content: `Please pick exactly ${teamSize} starters.` });
        }
        war._pendingStarters = selected;

        // Rebuild the UI with confirm enabled
        const poolArr = sortedPoolArray(war);
        const options = poolArr.slice(0, 25).map((p) => ({
          label: p.name,
          value: `${p.userId}`,
          description: `Joined ${new Date(p.joinedISO).toLocaleTimeString()}`,
        }));
        const select = new StringSelectMenuBuilder()
          .setCustomId(`select:pick:${warMsg.id}:${teamSize}`)
          .setPlaceholder(`Pick exactly ${teamSize} starters`)
          .setMinValues(teamSize)
          .setMaxValues(teamSize)
          .addOptions(options);
        const confirm = new ButtonBuilder().setCustomId(`select:confirm:${warMsg.id}`).setLabel('Confirm Roster').setStyle(ButtonStyle.Success).setDisabled(false);

        return interaction.update({
          content: `Selected **${teamSize}** starters. Click **Confirm Roster** to lock.`,
          components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(confirm)],
        });
      }
    }

    /* ---------- MODALS ---------- */
    if (interaction.isModalSubmit() && interaction.customId === 'new:oppmodal') {
      const wiz = newWizard.get(interaction.user.id);
      if (!wiz || !wiz.teamSize || !wiz.format) {
        return interaction.reply({ ephemeral: true, content: 'Setup expired. Run /warbot new again.' });
      }
      const opponent = interaction.fields.getTextInputValue('new:opp').trim();
      if (!opponent) {
        return interaction.reply({ ephemeral: true, content: 'Please enter an opponent.' });
      }
      wiz.opponent = opponent;
      newWizard.set(interaction.user.id, wiz);

      // Time picker (72h, 30-min slots) with simple pagination
      const now = new Date();
      now.setMinutes(now.getMinutes() - (now.getMinutes() % 30), 0, 0);
      const slots = 72 * 2;
      const options = [];
      for (let i = 0; i < slots; i++) {
        const d = new Date(now.getTime() + i * 30 * 60 * 1000);
        const et = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true, month: 'short', day: '2-digit' });
        options.push({ label: et, value: d.toISOString() });
      }
      const size = wiz.teamSize;
      const fmt = wiz.format;
      const oppEnc = encodeURIComponent(wiz.opponent);

      const select = new StringSelectMenuBuilder()
        .setCustomId(`new:time:${size}:${fmt}:${oppEnc}`)
        .setPlaceholder('Select start time (ET)')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options.slice(0, 25));

      const nextBtn = new ButtonBuilder().setCustomId(`new:timepage:1:${size}:${fmt}:${oppEnc}`).setLabel('Next Page').setStyle(ButtonStyle.Secondary);

      return interaction.reply({
        ephemeral: true,
        content: 'Pick a start time (ET).',
        components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(nextBtn)],
      });
    }

    /* ---------- TIME PAGE BUTTONS ---------- */
    if (interaction.isButton() && interaction.customId.startsWith('new:timepage:')) {
      const [, , pageStr, sizeStr, fmt, oppEnc] = interaction.customId.split(':');
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
      const total = Math.ceil(allOptions.length / perPage);
      const idx = Math.max(0, Math.min(page, total - 1));
      const opts = allOptions.slice(idx * perPage, idx * perPage + perPage);

      const select = new StringSelectMenuBuilder()
        .setCustomId(`new:time:${sizeNum}:${fmt}:${encodeURIComponent(opp)}`)
        .setPlaceholder(`Select start time (page ${idx + 1}/${total})`)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(opts);

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`new:timepage:${Math.max(idx - 1, 0)}:${sizeNum}:${fmt}:${encodeURIComponent(opp)}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
        new ButtonBuilder().setCustomId(`new:timepage:${Math.min(idx + 1, total - 1)}:${sizeNum}:${fmt}:${encodeURIComponent(opp)}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(idx >= total - 1)
      );

      return interaction.update({ content: 'Pick a start time (ET).', components: [new ActionRowBuilder().addComponents(select), buttons] });
    }
  } catch (err) {
    console.error('interaction error:', err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ ephemeral: true, content: 'Something went wrong.' }); } catch {}
    }
  }
});

/* ============== ROSTER DM TEXTS ============== */
function starterDM(war) {
  const opp = war.meta?.opponent ?? 'TBD';
  const fmt = (war.meta?.format ?? 'bo3').toUpperCase();
  const when = war.meta?.startET ?? 'TBD (ET)';
  return (
    `✅ **You are a STARTER**\n` +
    `Opponent: **${opp}**\nFormat: **${fmt}**\nStart: **${when}**\n\n` +
    `If you cannot make it, please unreact on the sign-up ASAP so admins can replace you.`
  );
}
function backupDM(war) {
  const opp = war.meta?.opponent ?? 'TBD';
  const fmt = (war.meta?.format ?? 'bo3').toUpperCase();
  const when = war.meta?.startET ?? 'TBD (ET)';
  return (
    `ℹ️ **You are a BACKUP (standby)**\n` +
    `Opponent: **${opp}**\nFormat: **${fmt}**\nStart: **${when}**\n\n` +
    `Stay ready. If a starter drops, you may be called up.`
  );
}

/* ============== REACTIONS (JOIN / CANCEL / DROP) ============== */
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const war = wars.get(reaction.message.id);
    if (!war) return;

    // Join
    if (reaction.emoji.name === '👍') {
      if (!war.pool.has(user.id)) {
        war.pool.set(user.id, { name: user.username, joinedISO: new Date().toISOString() });
        await updateSignupEmbed(reaction.message);
        // If roster was unlocked (after a drop), this will help fill backups again
      }
    }

    // Cancel whole sign-up (admins only)
    if (reaction.emoji.name === '🛑') {
      const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
      if (!isAdminish(member)) return;
      try { await reaction.message.delete(); } catch {}
      wars.delete(reaction.message.id);
      await reaction.message.channel.send('🛑 War sign-up **cancelled**.');
    }
  } catch (e) {
    console.error('messageReactionAdd error:', e);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const war = wars.get(reaction.message.id);
    if (!war) return;

    // Drop
    if (reaction.emoji.name === '👍') {
      const wasIn = war.pool.delete(user.id);
      if (wasIn) {
        // If locked and a starter dropped, unlock + ping admins
        if (war.locked && war.starters?.includes(user.id)) {
          war.locked = false;
          war.starters = war.starters.filter((id) => id !== user.id);
          // Try to auto-promote first backup if any
          if (war.backups?.length) {
            const next = war.backups.shift();
            if (next) war.starters.push(next);
          }
          // Ping admins; also recruit if no backups remain
          const alerts = [];
          if (process.env.ADMIN_PING_ROLE_ID) alerts.push(`<@&${process.env.ADMIN_PING_ROLE_ID}>`);
          let msg = `${alerts.join(' ')} A starter dropped; roster **unlocked**. Please re-select starters with \`/warbot select\`.`;
          if (!war.backups?.length && process.env.RECRUIT_PING_ROLE_ID) {
            msg += `\n<@&${process.env.RECRUIT_PING_ROLE_ID}> No backups remain—please recruit!`;
          }
          await reaction.message.channel.send(msg);
        }
        await updateSignupEmbed(reaction.message);
      }
    }
  } catch (e) {
    console.error('messageReactionRemove error:', e);
  }
});

/* ============== LOGIN ============== */
client.login(process.env.DISCORD_TOKEN);

/* =================== NOTES ===================
ENV (set any you need):
DISCORD_TOKEN=
CLIENT_ID=
GUILD_ID=
WAR_CHANNEL_ID=           (optional)
ROLE_ADMIN=               (optional)
ROLE_MANAGER=             (optional)
ROLE_KEEPER=              (optional)
ROLE_CAPTAIN=             (optional)
ADMIN_PING_ROLE_ID=       (optional)
RECRUIT_PING_ROLE_ID=     (optional)
*/

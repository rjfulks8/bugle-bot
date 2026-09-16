import { 
  Client, 
  GatewayIntentBits, 
  SlashCommandBuilder, 
  REST, 
  Routes, 
  EmbedBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ActionRowBuilder, 
  ComponentType 
} from 'discord.js';
import cron from 'node-cron';
import fs from 'fs';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

// Keep-alive HTTP server for Render Free Tier
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Daily Bugle Bot is running 24/7!\n');
}).listen(port, () => {
  console.log(`🌐 Web server listening on port ${port}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Load local state files safely
let state = { guilds: {} };
if (fs.existsSync('state.json')) {
  try {
    const raw = JSON.parse(fs.readFileSync('state.json', 'utf8'));
    if (raw.guilds) state = raw;
  } catch (e) {
    console.error("Error reading state.json:", e);
  }
}

let submissions = [];
if (fs.existsSync('submissions.json')) {
  try {
    submissions = JSON.parse(fs.readFileSync('submissions.json', 'utf8'));
    submissions.forEach(sub => {
      if (!sub.voters) sub.voters = [];
    });
  } catch (e) {
    console.error("Error reading submissions.json:", e);
  }
}

let assignments = [];
if (fs.existsSync('assignments.json')) {
  try {
    assignments = JSON.parse(fs.readFileSync('assignments.json', 'utf8'));
  } catch (e) {
    console.error("Error reading assignments.json:", e);
  }
}

function saveState() {
  fs.writeFileSync('state.json', JSON.stringify(state, null, 2));
}

function saveSubmissions() {
  fs.writeFileSync('submissions.json', JSON.stringify(submissions, null, 2));
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getYesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Helper to calculate specific server's Day index based on its startDate
function getGuildDayIndex(startDateStr) {
  if (!assignments.length) return 0;
  
  const [sYear, sMonth, sDay] = startDateStr.split('-').map(Number);
  const startDate = Date.UTC(sYear, sMonth - 1, sDay);

  const now = new Date();
  const todayDate = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

  const diffDays = Math.floor((todayDate - startDate) / (1000 * 60 * 60 * 24));
  return ((diffDays % assignments.length) + assignments.length) % assignments.length;
}

// Auto-register guild safely without hardcoding fallbacks
function ensureGuildRegistered(guildId, channelId = null) {
  if (!state.guilds) state.guilds = {};

  if (!state.guilds[guildId]) {
    state.guilds[guildId] = {
      startDate: getTodayKey(),
      announcementChannelId: channelId || null
    };
    saveState();
  } else if (channelId && state.guilds[guildId].announcementChannelId !== channelId) {
    state.guilds[guildId].announcementChannelId = channelId;
    saveState();
  }
}

async function sendDailyAssignmentForGuild(guildId) {
  const guildData = state.guilds[guildId];
  if (!guildData || !guildData.announcementChannelId) return;

  try {
    const channel = await client.channels.fetch(guildData.announcementChannelId).catch(() => null);
    if (!channel) {
      console.log(`Skipping assignment dispatch for Guild ${guildId}: Channel ${guildData.announcementChannelId} not found.`);
      return;
    }

    const currentIndex = getGuildDayIndex(guildData.startDate);
    const assignmentText = assignments[currentIndex];

    const embed = new EmbedBuilder()
      .setTitle('🚨 ATTENTION BUGLE STAFF!')
      .setDescription(`**TODAY'S ASSIGNMENT:**\n"${assignmentText}"\n\nSubmit your photo evidence using \`/submit\`!`)
      .setColor('#FF0000')
      .setFooter({ text: `Day ${currentIndex + 1} of 100` });

    await channel.send({ embeds: [embed] }).catch(err => console.error(`Failed to send assignment to guild ${guildId}:`, err));
  } catch (err) {
    console.error(`Error sending assignment to guild ${guildId}:`, err);
  }
}

async function announceDailyWinnerForGuild(guildId) {
  const guildData = state.guilds[guildId];
  if (!guildData || !guildData.announcementChannelId) return;

  try {
    const channel = await client.channels.fetch(guildData.announcementChannelId).catch(() => null);
    if (!channel) {
      console.log(`Skipping winner announcement for Guild ${guildId}: Channel not found.`);
      return;
    }

    const todayKey = getTodayKey();
    
    // STRICT FILTER: Match date AND exact string representation of guildId
    const todaysSubmissions = submissions.filter(s => s.date === todayKey && String(s.guildId) === String(guildId));

    if (todaysSubmissions.length === 0) {
      return channel.send("📰 **DAILY BUGLE EXTRA!** There were ZERO photos on my desk today! No front-page story tonight!").catch(() => {});
    }

    const maxVotes = Math.max(...todaysSubmissions.map(s => s.voters?.length || 0));
    const topSubmissions = todaysSubmissions.filter(s => (s.voters?.length || 0) === maxVotes);

    if (topSubmissions.length > 1) {
      const winnerTags = topSubmissions.map(s => `<@${s.userId}>`).join(' and ');
      
      const winnerEmbed = new EmbedBuilder()
        .setTitle('📰 DAILY BUGLE CO-FRONT PAGE WINNERS!')
        .setDescription(`Stop the presses! It's a dead heat! ${winnerTags} both earned the front page tonight!\n\n**Total Votes:** ${maxVotes} each`)
        .setImage(topSubmissions[0].imageUrl)
        .setColor('#FFD700')
        .setFooter({ text: `Co-Front Page Selection for ${todayKey}` });

      await channel.send({
        content: `🚨 **STOP THE PRESSES! IT'S A TIE!** ${winnerTags} share the front page!`,
        embeds: [winnerEmbed]
      }).catch(err => console.error(`Failed to send tie announcement to guild ${guildId}:`, err));
    } else {
      const winner = topSubmissions[0];
      const voteCount = winner.voters?.length || 0;

      const winnerEmbed = new EmbedBuilder()
        .setTitle('📰 DAILY BUGLE FRONT PAGE WINNER!')
        .setDescription(`<@${winner.userId}> good job kid, you made the front page today!\n\n**Total Votes:** ${voteCount}`)
        .setImage(winner.imageUrl)
        .setColor('#FFD700')
        .setFooter({ text: `Front Page Selection for ${todayKey}` });

      await channel.send({
        content: `🚨 <@${winner.userId}> **has secured the front page!**`,
        embeds: [winnerEmbed]
      }).catch(err => console.error(`Failed to send winner announcement to guild ${guildId}:`, err));
    }
  } catch (err) {
    console.error(`Error announcing winner for guild ${guildId}:`, err);
  }
}

function cleanupOldSubmissions() {
  const yesterdayKey = getYesterdayKey();
  const initialLength = submissions.length;

  submissions = submissions.filter(s => s.date !== yesterdayKey);

  const removedCount = initialLength - submissions.length;
  saveSubmissions();
  console.log(`🧹 Midnight Cleanup: Purged ${removedCount} submission(s) from ${yesterdayKey}.`);
}

const commands = [
  new SlashCommandBuilder()
    .setName('submit')
    .setDescription("Submit your photo for today's Daily Bugle assignment!")
    .addAttachmentOption(option =>
      option.setName('photo')
        .setDescription('Upload your photo')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('bugle-gallery')
    .setDescription("View today's submissions for J. Jonah Jameson and vote for the winner!"),
  new SlashCommandBuilder()
    .setName('test-dispatch')
    .setDescription("Force trigger the daily assignment dispatch across all registered servers!")
];

client.once('clientReady', async () => {
  console.log(`📰 Daily Bugle Bot is online as ${client.user.tag}!`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('Successfully updated slash commands globally!');
  } catch (err) {
    console.error('Error registering slash commands:', err);
  }

  // 9 AM Daily Assignment Dispatch
  cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Running 9 AM Daily Bugle Assignment Dispatch across all servers...');
    for (const guildId of Object.keys(state.guilds)) {
      await sendDailyAssignmentForGuild(guildId);
    }
  });

  // 11 PM Winner Announcement
  cron.schedule('0 23 * * *', async () => {
    console.log('🏆 Running 11 PM Daily Bugle Winner Announcement across all servers...');
    for (const guildId of Object.keys(state.guilds)) {
      await announceDailyWinnerForGuild(guildId);
    }
  });

  // 12 AM Cleanup
  cron.schedule('0 0 * * *', () => {
    cleanupOldSubmissions();
  });
});

client.on('guildCreate', (guild) => {
  console.log(`Joined new server: ${guild.name} (${guild.id})`);
  ensureGuildRegistered(guild.id);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  ensureGuildRegistered(guildId, interaction.channelId);

  const todayKey = getTodayKey();

  if (interaction.commandName === 'test-dispatch') {
    await interaction.reply({
      content: '⚡ Force triggering daily assignment dispatch across all servers...',
      flags: 64
    });

    for (const id of Object.keys(state.guilds)) {
      await sendDailyAssignmentForGuild(id);
    }
  }

  if (interaction.commandName === 'submit') {
    const attachment = interaction.options.getAttachment('photo');

    if (!attachment.contentType?.startsWith('image/')) {
      return interaction.reply({
        content: "JJJ only accepts IMAGES! Don't waste my time with non-image files!",
        flags: 64
      });
    }

    submissions.push({
      id: Date.now(),
      guildId: String(guildId),
      date: todayKey,
      userId: interaction.user.id,
      username: interaction.user.username,
      imageUrl: attachment.url,
      voters: []
    });
    saveSubmissions();

    await interaction.reply({
      content: `📸 **Photo accepted!** Jameson tossed it onto his desk. Use \`/bugle-gallery\` to see today's entries.`,
      flags: 64
    });

    if (interaction.channel) {
      await interaction.channel.send({
        content: `📰 <@${interaction.user.id}> just submitted a photo for today's assignment!`
      }).catch(err => console.error("Could not post channel submission alert:", err));
    }
  }

  if (interaction.commandName === 'bugle-gallery') {
    const todaysSubmissions = submissions.filter(s => s.date === todayKey && String(s.guildId) === String(guildId));

    if (todaysSubmissions.length === 0) {
      return interaction.reply({
        content: "There are ZERO photos on my desk today! You call yourselves journalists?!",
        flags: 64
      });
    }

    let currentIndex = 0;

    const generateEmbed = (index) => {
      const item = todaysSubmissions[index];
      const voteCount = item.voters ? item.voters.length : 0;

      return new EmbedBuilder()
        .setTitle(`📸 Today's Bugle Submissions (${index + 1} of ${todaysSubmissions.length})`)
        .setDescription(`Submitted by <@${item.userId}> (${item.username})\n\n⭐ **Votes:** ${voteCount}`)
        .setImage(item.imageUrl)
        .setColor('#0099FF')
        .setFooter({ text: `Use buttons below to vote or flip through photos` });
    };

    const generateButtons = (index, userId) => {
      const item = todaysSubmissions[index];
      const hasVotedThis = item.voters && item.voters.includes(userId);

      const prevButton = new ButtonBuilder()
        .setCustomId('prev_photo')
        .setLabel('◀ Previous')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(index === 0);

      const voteButton = new ButtonBuilder()
        .setCustomId('vote_photo')
        .setLabel(hasVotedThis ? '⭐ Voted' : '⭐ Vote for this Photo')
        .setStyle(hasVotedThis ? ButtonStyle.Success : ButtonStyle.Secondary);

      const nextButton = new ButtonBuilder()
        .setCustomId('next_photo')
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(index === todaysSubmissions.length - 1);

      return new ActionRowBuilder().addComponents(prevButton, voteButton, nextButton);
    };

    const response = await interaction.reply({
      embeds: [generateEmbed(currentIndex)],
      components: [generateButtons(currentIndex, interaction.user.id)],
      fetchReply: true
    });

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 900000 
    });

    collector.on('collect', async (btnInteraction) => {
      const voterId = btnInteraction.user.id;

      if (btnInteraction.customId === 'prev_photo' && currentIndex > 0) {
        currentIndex--;
      } else if (btnInteraction.customId === 'next_photo' && currentIndex < todaysSubmissions.length - 1) {
        currentIndex++;
      } else if (btnInteraction.customId === 'vote_photo') {
        todaysSubmissions.forEach(sub => {
          if (!sub.voters) sub.voters = [];
          const idx = sub.voters.indexOf(voterId);
          if (idx !== -1) sub.voters.splice(idx, 1);
        });

        const currentItem = todaysSubmissions[currentIndex];
        if (!currentItem.voters) currentItem.voters = [];
        currentItem.voters.push(voterId);

        saveSubmissions();
      }

      await btnInteraction.update({
        embeds: [generateEmbed(currentIndex)],
        components: [generateButtons(currentIndex, voterId)]
      }).catch(err => console.error("Error updating button interaction:", err));
    });

    collector.on('end', async () => {
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev_disabled').setLabel('◀ Previous').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('vote_disabled').setLabel('⭐ Voting Closed').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('next_disabled').setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(true)
      );
      await interaction.editReply({ components: [disabledRow] }).catch(() => {});
    });
  }
});

client.login(process.env.DISCORD_TOKEN);

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

// Load local state files
let state = { currentIndex: 0, startDate: null };
if (fs.existsSync('state.json')) {
  state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
}

let submissions = [];
if (fs.existsSync('submissions.json')) {
  submissions = JSON.parse(fs.readFileSync('submissions.json', 'utf8'));
}

let assignments = [];
if (fs.existsSync('assignments.json')) {
  assignments = JSON.parse(fs.readFileSync('assignments.json', 'utf8'));
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

async function sendDailyAssignment(channel) {
  if (!assignments.length) return;

  const assignmentText = assignments[state.currentIndex];

  const embed = new EmbedBuilder()
    .setTitle('🚨 ATTENTION BUGLE STAFF!')
    .setDescription(`**TODAY'S ASSIGNMENT:**\n"${assignmentText}"\n\nSubmit your photo evidence using \`/submit\`!`)
    .setColor('#FF0000')
    .setFooter({ text: `Day ${state.currentIndex + 1} of 100` });

  await channel.send({ embeds: [embed] });

  // Advance to next assignment for tomorrow (loops after 100 days)
  state.currentIndex = (state.currentIndex + 1) % assignments.length;
  saveState();
}

// Register Official Production Commands
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
    .setDescription("View today's submissions for J. Jonah Jameson!")
];

client.once('clientReady', async () => {
  console.log(`📰 Daily Bugle Bot is online as ${client.user.tag}!`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('Successfully updated slash commands!');
  } catch (err) {
    console.error('Error registering slash commands:', err);
  }

  // Scheduled 9 AM daily dispatch
  cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Running 9 AM Daily Bugle Assignment Dispatch...');
    const targetChannel = await client.channels.fetch(process.env.ANNOUNCEMENT_CHANNEL_ID);
    if (targetChannel) await sendDailyAssignment(targetChannel);
  });
});

// Handle Slash Command Interactions
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const todayKey = getTodayKey();

  // --- /submit ---
  if (interaction.commandName === 'submit') {
    const attachment = interaction.options.getAttachment('photo');

    if (!attachment.contentType?.startsWith('image/')) {
      return interaction.reply({
        content: "JJJ only accepts IMAGES! Don't waste my time with non-image files!",
        ephemeral: true
      });
    }

    submissions.push({
      id: Date.now(),
      date: todayKey,
      userId: interaction.user.id,
      username: interaction.user.username,
      imageUrl: attachment.url
    });
    saveSubmissions();

    await interaction.reply({
      content: `📸 **Photo accepted!** Jameson tossed it onto his desk. Use \`/bugle-gallery\` to see today's entries.`,
      ephemeral: true
    });

    return interaction.channel.send({
      content: `📰 <@${interaction.user.id}> just submitted a photo for today's assignment!`
    });
  }

  // --- /bugle-gallery WITH BUTTON PAGINATION ---
  if (interaction.commandName === 'bugle-gallery') {
    const todaysSubmissions = submissions.filter(s => s.date === todayKey);

    if (todaysSubmissions.length === 0) {
      return interaction.reply({
        content: "There are ZERO photos on my desk today! You call yourselves journalists?!",
        ephemeral: true
      });
    }

    let currentIndex = 0;

    // Helper function to build embed for a specific page index
    const generateEmbed = (index) => {
      const item = todaysSubmissions[index];
      return new EmbedBuilder()
        .setTitle(`📸 Today's Bugle Submissions (${index + 1} of ${todaysSubmissions.length})`)
        .setDescription(`Submitted by <@${item.userId}> (${item.username})`)
        .setImage(item.imageUrl)
        .setColor('#0099FF')
        .setFooter({ text: `Use buttons below to flip through photos` });
    };

    // Helper function to build row with Previous and Next buttons
    const generateButtons = (index) => {
      const prevButton = new ButtonBuilder()
        .setCustomId('prev_photo')
        .setLabel('◀ Previous')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(index === 0);

      const nextButton = new ButtonBuilder()
        .setCustomId('next_photo')
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(index === todaysSubmissions.length - 1);

      return new ActionRowBuilder().addComponents(prevButton, nextButton);
    };

    // Send initial gallery response
    const response = await interaction.reply({
      embeds: [generateEmbed(currentIndex)],
      components: todaysSubmissions.length > 1 ? [generateButtons(currentIndex)] : [],
      fetchReply: true
    });

    // If there's only 1 photo, no need to set up button listeners
    if (todaysSubmissions.length <= 1) return;

    // Create collector for button interactions (active for 5 minutes)
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 300000 
    });

    collector.on('collect', async (btnInteraction) => {
      if (btnInteraction.customId === 'prev_photo' && currentIndex > 0) {
        currentIndex--;
      } else if (btnInteraction.customId === 'next_photo' && currentIndex < todaysSubmissions.length - 1) {
        currentIndex++;
      }

      await btnInteraction.update({
        embeds: [generateEmbed(currentIndex)],
        components: [generateButtons(currentIndex)]
      });
    });

    // Disable buttons when the 5-minute timeout expires
    collector.on('end', async () => {
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev_disabled').setLabel('◀ Previous').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('next_disabled').setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(true)
      );
      await interaction.editReply({ components: [disabledRow] }).catch(() => {});
    });
  }
});

client.login(process.env.DISCORD_TOKEN);

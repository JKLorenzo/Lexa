import 'newrelic';
import { Client, Intents } from 'discord.js';
import { initGame } from './managers/game.js';
import { initInteraction } from './managers/interaction.js';
import { initPlay } from './managers/play.js';
import { connectDb } from './modules/database.js';
import { initTelemetry } from './modules/telemetry.js';

export const client = new Client({
  allowedMentions: {
    parse: ['everyone', 'roles', 'users'],
    repliedUser: true,
  },
  intents: [
    Intents.FLAGS.DIRECT_MESSAGES,
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_BANS,
    Intents.FLAGS.GUILD_INVITES,
    Intents.FLAGS.GUILD_MEMBERS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_PRESENCES,
    Intents.FLAGS.GUILD_VOICE_STATES,
  ],
  partials: ['MESSAGE', 'CHANNEL'],
  presence: {
    status: 'online',
    afk: false,
  },
});

client.on('ready', async () => {
  console.log('Online');
  await connectDb();
  await initTelemetry();
  await initInteraction();
  await initGame();
  await initPlay();
  console.log('Initialized');
});

client.login(process.env.BOT_TOKEN!);

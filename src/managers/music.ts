import {
  AudioPlayer,
  AudioPlayerStatus,
  AudioResource,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import {
  CommandInteraction,
  Guild,
  GuildMember,
  Message,
  MessageComponentInteraction,
  Snowflake,
  TextChannel,
} from 'discord.js';
import fetch from 'node-fetch';
import { raw as ytdl } from 'youtube-dl-exec';
import ytdl_core from 'ytdl-core';
import { getComponent } from './interaction.js';
import { getSoundCloudPlaylist, getSoundCloudTrack } from '../modules/soundcloud.js';
import { getPlaylist, getTrack } from '../modules/spotify.js';
import { searchYouTube } from '../modules/youtube.js';
import { hasAll, hasAny, parseHTML, sleep } from '../utils/functions.js';
const { getInfo } = ytdl_core;

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

const _subscriptions = new Map<Snowflake, MusicSubscription>();

interface TrackData {
  query: string;
  title?: string;
  image?: string;
  onStart: () => void;
  onFinish: () => void;
  onError: (error: Error) => void;
}

export function getSubscription(guild_id: Snowflake): MusicSubscription | undefined {
  return _subscriptions.get(guild_id);
}

export function setSubscription(guild_id: Snowflake, subscription: MusicSubscription): void {
  _subscriptions.set(guild_id, subscription);
}

export function deleteSubscription(guild_id: Snowflake): void {
  _subscriptions.delete(guild_id);
}

export class Track implements TrackData {
  query: string;
  title?: string;
  image?: string;
  onStart: () => void;
  onFinish: () => void;
  onError: (error: Error) => void;

  constructor(channel: TextChannel, query: string, title?: string, image?: string) {
    this.query = query;
    this.title = title;
    this.image = image;

    let message: Message | undefined;

    this.onStart = () => {
      this.onStart = noop;
      if (channel && !message) {
        const voice_channel = channel.guild.me?.voice.channel;
        const subscription = getSubscription(channel.guildId);
        const nextTrack = subscription?.queue.at(0);

        channel
          .send({
            embeds: [
              {
                author: { name: 'Parallax Music Player: Now Playing' },
                title: this.title,
                description: nextTrack ? `Up Next: ${nextTrack.title}` : '',
                footer: {
                  text: `Channel: ${voice_channel?.name ?? 'Unknown'}  |  Region: ${
                    voice_channel?.rtcRegion
                      ?.split(' ')
                      .map(s => `${s.charAt(0).toUpperCase()}${s.slice(1)}`) ?? 'Automatic'
                  }  |  Bitrate: ${
                    voice_channel ? `${voice_channel.bitrate / 1000}kbps` : 'Unknown'
                  }`,
                },
                thumbnail: { url: this.image },
                color: 'GREEN',
              },
            ],
            components: getComponent('music'),
          })
          .then(msg => (message = msg))
          .catch(console.warn);
      }
    };

    this.onFinish = () => {
      this.onFinish = noop;
      if (message && message.editable) {
        message
          .edit({
            embeds: [
              message.embeds[0]
                .setAuthor('Parallax Music Player: Previously Played')
                .setColor('YELLOW'),
            ],
            components: [],
          })
          .catch(console.warn);
        setTimeout(() => {
          if (message && message.deletable) message.delete().catch(console.warn);
        }, 10000);
      }
    };

    this.onError = error => {
      this.onError = noop;
      console.warn(error);
      if (message && message.deletable) message.delete().catch(console.warn);
    };
  }

  async createAudioResource(): Promise<AudioResource<Track>> {
    if (!hasAny(this.query, 'http') || hasAny(this.query, 'youtube.com')) {
      let url;
      if (hasAny(this.query, 'http')) {
        url = this.query;
      } else {
        const data = await searchYouTube(this.query);
        if (!data) throw new Error('No track found.');

        const title = parseHTML(data.title).trim();
        const author = parseHTML(data.channelTitle).trim();

        url = data.link;
        if (!this.title) this.title = `${title} by ${author}`;
        if (!this.image) this.image = data.thumbnails.default?.url;
      }

      if (!this.title || !this.image) {
        const info = await getInfo(url);
        if (!info) throw new Error('No track info found.');

        const title = parseHTML(info.videoDetails.title).trim();
        const author = parseHTML(info.videoDetails.ownerChannelName).trim();

        if (!this.title) this.title = `${title} by ${author}`;
        if (!this.image) this.image = info.thumbnail_url;
      }

      const process = ytdl(
        url,
        {
          o: '-',
          q: '',
          f: 'bestaudio[ext=webm+acodec=opus+asr=48000]/bestaudio',
          r: '100K',
        },
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );

      return new Promise((resolve, reject) => {
        if (!process.stdout) return reject(new Error('No stdout'));

        const stream = process.stdout;
        const onError = (error: Error) => {
          if (!process.killed) process.kill();
          stream.resume();
          reject(error);
        };

        process
          .once('spawn', () => {
            demuxProbe(stream)
              .then(probe =>
                resolve(
                  createAudioResource(probe.stream, { metadata: this, inputType: probe.type }),
                ),
              )
              .catch(onError);
          })
          .catch(onError);
      });
    } else if (hasAll(this.query, ['http', 'soundcloud'])) {
      const song = await getSoundCloudTrack(this.query);
      if (!song) throw new Error('Track not found.');

      const title = parseHTML(song.title).trim();
      const author = parseHTML(song.author.name).trim();

      if (!this.title) this.title = `${title} by ${author}`;
      if (!this.image) this.image = song.thumbnail;

      return new Promise((resolve, reject) => {
        song.downloadProgressive().then(stream => {
          const onError = (error: Error) => {
            if (!stream.destroyed) stream.destroy();
            stream.resume();
            reject(error);
          };

          demuxProbe(stream)
            .then(probe =>
              resolve(createAudioResource(probe.stream, { metadata: this, inputType: probe.type })),
            )
            .catch(onError);
        });
      });
    } else {
      throw new Error('Unsupported Format');
    }
  }
}

export class MusicSubscription {
  readonly voiceConnection: VoiceConnection;
  readonly audioPlayer: AudioPlayer;
  queue: Track[];
  queueLock = false;
  readyLock = false;

  constructor(voiceConnection: VoiceConnection) {
    this.voiceConnection = voiceConnection;
    this.audioPlayer = createAudioPlayer();
    this.queue = [];

    this.voiceConnection.on('stateChange', async (_, newState) => {
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        if (
          newState.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
          newState.closeCode === 4014
        ) {
          /*
						If the WebSocket closed with a 4014 code, this means that we should not manually attempt to reconnect,
						but there is a chance the connection will recover itself if the reason of the disconnect was due to
						switching voice channels. This is also the same code for the bot being kicked from the voice channel,
						so we allow 5 seconds to figure out which scenario it is. If the bot has been kicked, we should destroy
						the voice connection.
					*/
          try {
            await entersState(this.voiceConnection, VoiceConnectionStatus.Connecting, 5_000);
            // Probably moved voice channel
          } catch {
            this.voiceConnection.destroy();
            // Probably removed from voice channel
          }
        } else if (this.voiceConnection.rejoinAttempts < 5) {
          /*
						The disconnect in this case is recoverable, and we also have <5 repeated attempts so we will reconnect.
					*/
          await sleep((this.voiceConnection.rejoinAttempts + 1) * 5_000);
          this.voiceConnection.rejoin();
        } else {
          /*
						The disconnect in this case may be recoverable, but we have no more remaining attempts - destroy.
					*/
          this.voiceConnection.destroy();
        }
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        /*
					Once destroyed, stop the subscription
				*/
        this.stop({ force: true });
      } else if (
        !this.readyLock &&
        (newState.status === VoiceConnectionStatus.Connecting ||
          newState.status === VoiceConnectionStatus.Signalling)
      ) {
        /*
					In the Signalling or Connecting states, we set a 20 second time limit for the connection to become ready
					before destroying the voice connection. This stops the voice connection permanently existing in one of these
					states.
				*/
        this.readyLock = true;
        try {
          await entersState(this.voiceConnection, VoiceConnectionStatus.Ready, 20_000);
        } catch {
          if (this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
            this.voiceConnection.destroy();
          }
        } finally {
          this.readyLock = false;
        }
      }
    });

    // Configure audio player
    this.audioPlayer.on('stateChange', (oldState, newState) => {
      if (
        newState.status === AudioPlayerStatus.Idle &&
        oldState.status !== AudioPlayerStatus.Idle
      ) {
        // If the Idle state is entered from a non-Idle state, it means that an audio resource has finished playing.
        // The queue is then processed to start playing the next track, if one is available.
        (oldState.resource as AudioResource<Track>).metadata.onFinish();
        this.processQueue();
      } else if (newState.status === AudioPlayerStatus.Playing) {
        // If the Playing state has been entered, then a new track has started playback.
        (newState.resource as AudioResource<Track>).metadata.onStart();
      }
    });

    this.audioPlayer.on('error', error =>
      (error.resource as AudioResource<Track>).metadata.onError(error),
    );

    voiceConnection.subscribe(this.audioPlayer);
  }

  enqueue(channel: TextChannel, query: string, title?: string, image?: string): Track {
    const track = new Track(channel, query, title, image);
    this.queue.push(track);
    this.processQueue();
    return track;
  }

  stop(options?: { skipCount?: number; force?: boolean }): number {
    let skipped = 0;
    if (options?.force) this.queueLock = true;
    if (options?.skipCount) {
      if (options?.skipCount > 1) {
        skipped = this.queue.splice(0, options?.skipCount - 1).length;
        skipped += this.audioPlayer.state.status === AudioPlayerStatus.Idle ? 0 : 1;
      }
    } else {
      this.queue = [];
    }
    this.audioPlayer.stop(options?.force);
    return skipped;
  }

  private async processQueue(): Promise<void> {
    // If the queue is locked (already being processed), is empty, or the audio player is already playing something, return
    if (
      this.queueLock ||
      this.audioPlayer.state.status !== AudioPlayerStatus.Idle ||
      this.queue.length === 0
    ) {
      return;
    }
    // Lock the queue to guarantee safe access
    this.queueLock = true;

    // Take the first item from the queue. This is guaranteed to exist due to the non-empty check above.
    const nextTrack = this.queue.shift()!;
    try {
      // Attempt to convert the Track into an AudioResource (i.e. start streaming the video)
      const resource = await nextTrack.createAudioResource();
      this.audioPlayer.play(resource);
      this.queueLock = false;
    } catch (error) {
      // If an error occurred, try the next item of the queue instead
      nextTrack.onError(error as Error);
      this.queueLock = false;
      return this.processQueue();
    }
  }
}

export async function musicPlay(interaction: CommandInteraction): Promise<unknown> {
  await interaction.deferReply();

  const song = interaction.options.getString('song', true).trim();
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  let subscription = getSubscription(guild.id);

  if (subscription && subscription.queue.length > 0 && current_voice_channel?.id !== channel?.id) {
    return interaction.followUp("I'm currently playing on another channel.");
  }

  if (
    channel &&
    (!subscription ||
      (subscription.audioPlayer.state.status === AudioPlayerStatus.Idle &&
        subscription.queue.length === 0))
  ) {
    subscription = new MusicSubscription(
      joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
      }),
    );
    subscription.voiceConnection.on('error', console.warn);
    setSubscription(guild.id, subscription);
  }

  // If there is no subscription, tell the user they need to join a channel.
  if (!subscription) {
    return interaction.followUp('Join a voice channel and then try that again.');
  }

  // Make sure the connection is ready before processing the user's request
  try {
    await entersState(subscription.voiceConnection, VoiceConnectionStatus.Ready, 20e3);
  } catch (error) {
    console.warn(error);
    return interaction.followUp(
      'Failed to join voice channel within 20 seconds, please try again later.',
    );
  }

  try {
    const enqueue = (query: string, title?: string, image?: string): Track =>
      subscription!.enqueue(interaction.channel as TextChannel, query, title, image);

    if (hasAny(song, 'http')) {
      if (hasAny(song, 'youtube.com')) {
        const info = await getInfo(song);
        if (!info) return interaction.editReply('Track not found.');

        const title = parseHTML(info.videoDetails.title).trim();
        const author = parseHTML(info.videoDetails.author.name).trim();

        await enqueue(song, `${title} by ${author}`, info.thumbnail_url);
        await interaction.followUp(`Enqueued **${title}** by **${author}**.`);
      } else if (hasAny(song, 'spotify.com')) {
        if (hasAny(song, '/playlist')) {
          const playlist = await getPlaylist(song);

          for (const item of playlist.tracks.items) {
            const title = parseHTML(item.track.name).trim();
            const author = parseHTML(item.track.artists.map(a => a.name).join(', ')).trim();

            await enqueue(
              `${title} ${author}`,
              `${title} by ${author}`,
              item.track.album.images[0]?.url,
            );
          }

          const title = parseHTML(playlist.name).trim();
          const author = parseHTML(playlist.owner.display_name ?? '').trim();

          await interaction.followUp(
            `Enqueued ${playlist.tracks.items.length} songs from ` +
              `**${title}** playlist${author ? ` by **${author}**` : ''}.`,
          );
        } else if (hasAny(song, '/track')) {
          const track = await getTrack(song);

          const title = parseHTML(track.name).trim();
          const author = parseHTML(track.artists.map(a => a.name).join(', ')).trim();

          await enqueue(`${title} ${author}`, `${title} by ${author}`, track.album.images[0]?.url);
          await interaction.followUp(`Enqueued **${title}** by **${author}**.`);
        } else {
          return interaction.editReply('This link is currently not supported.');
        }
      } else if (hasAny(song, 'soundcloud')) {
        const response = await fetch(song);
        if (hasAny(response.url, '/sets/')) {
          const playlist = await getSoundCloudPlaylist(response.url);
          if (!playlist) return interaction.editReply('No match found, please try again.');

          for (const item of playlist.tracks) {
            const title = parseHTML(item.title).trim();
            const author = parseHTML(item.author.name).trim();

            await enqueue(item.url, `${title} by ${author}`, item.thumbnail);
          }

          const title = parseHTML(playlist.title).trim();
          const author = parseHTML(playlist.author.name).trim();

          await interaction.followUp(
            `Enqueued ${playlist.trackCount} songs from **${title}** playlist by **${author}**.`,
          );
        } else {
          const data = await getSoundCloudTrack(response.url);
          if (!data) return interaction.editReply('No match found, please try again.');

          const title = parseHTML(data.title).trim();
          const author = parseHTML(data.author.name).trim();

          await enqueue(response.url, `${title} by ${author}`, data.thumbnail);
          await interaction.followUp(`Enqueued **${title}** by **${author}**.`);
        }
      } else {
        await interaction.editReply('This link is currently not supported.');
      }
    } else {
      const data = await searchYouTube(song);
      if (!data) return interaction.editReply('No match found, please try again.');

      const title = parseHTML(data.title).trim();
      const author = parseHTML(data.channelTitle).trim();

      await enqueue(data.link, `${title} by ${author}`, data.thumbnails.default?.url);
      await interaction.followUp(`Enqueued **${title}** by **${author}**.`);
    }
  } catch (error) {
    console.warn(error);
    await interaction.editReply('Failed to play track, please try again later.');
  }
}

export async function musicSkip(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<unknown> {
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  const subscription = getSubscription(guild.id);

  if (subscription && current_voice_channel?.id !== channel?.id) {
    return interaction.reply({
      content: "You must be on the same channel where I'm currently active to perform this action.",
      ephemeral: true,
    });
  }

  if (!subscription) {
    if (interaction instanceof CommandInteraction) {
      return interaction.reply({
        content: 'Not playing in this server.',
        ephemeral: true,
      });
    } else {
      return interaction.deferUpdate();
    }
  }

  if (interaction instanceof CommandInteraction) {
    const count = interaction.options.getInteger('count', false) ?? 1;
    const skipped = subscription.stop({ skipCount: count });

    await interaction.reply({
      content: `Skipped ${skipped} ${skipped > 1 ? 'songs' : 'song'}.`,
      ephemeral: true,
    });
  } else {
    subscription.stop({ skipCount: 1 });
    await interaction.deferUpdate();
  }
}

export async function musicStop(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<unknown> {
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  const subscription = getSubscription(guild.id);

  if (subscription && current_voice_channel?.id !== channel?.id) {
    return interaction.reply({
      content: "You must be on the same channel where I'm currently active to perform this action.",
      ephemeral: true,
    });
  }

  if (!subscription) {
    if (interaction instanceof CommandInteraction) {
      return interaction.reply({
        content: 'Not playing in this server.',
        ephemeral: true,
      });
    } else {
      return interaction.deferUpdate();
    }
  }

  subscription.stop({ force: true });
  if (interaction instanceof CommandInteraction) {
    await interaction.reply({
      content: 'Stopped all songs.',
      ephemeral: true,
    });
  } else {
    await interaction.deferUpdate();
  }
}

export async function musicQueue(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<void> {
  const guild = interaction.guild as Guild;
  const subscription = getSubscription(guild.id);

  if (!subscription) {
    if (interaction instanceof CommandInteraction) {
      return interaction.reply({
        content: 'Not playing in this server.',
        ephemeral: true,
      });
    } else {
      return interaction.deferUpdate();
    }
  }

  const current =
    subscription.audioPlayer.state.status === AudioPlayerStatus.Idle
      ? `Nothing is currently playing!`
      : `**Now Playing:**\n${
          (subscription.audioPlayer.state.resource as AudioResource<Track>).metadata.title
        }`;

  const queue = subscription.queue
    .slice(0, 10)
    .map((track, index) => `${index + 1}) ${track.title}`)
    .join('\n');

  await interaction.reply({
    content: `${current}\n\n**On Queue: ${subscription.queue.length}**\n${queue}`,
    ephemeral: true,
  });
}

export async function musicPause(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<unknown> {
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  const subscription = getSubscription(guild.id);

  if (subscription && current_voice_channel?.id !== channel?.id) {
    return interaction.reply({
      content: "You must be on the same channel where I'm currently active to perform this action.",
      ephemeral: true,
    });
  }

  if (!subscription) {
    if (interaction instanceof CommandInteraction) {
      return interaction.reply({
        content: 'Not playing in this server.',
        ephemeral: true,
      });
    } else {
      return interaction.deferUpdate();
    }
  }

  subscription.audioPlayer.pause();
  if (interaction instanceof CommandInteraction) {
    await interaction.reply({
      content: 'Paused.',
      ephemeral: true,
    });
  } else {
    await interaction.deferUpdate();
  }
}

export async function musicResume(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<unknown> {
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  const subscription = getSubscription(guild.id);

  if (subscription && current_voice_channel?.id !== channel?.id) {
    return interaction.reply({
      content: "You must be on the same channel where I'm currently active to perform this action.",
      ephemeral: true,
    });
  }

  if (!subscription) {
    if (interaction instanceof CommandInteraction) {
      return interaction.reply({
        content: 'Not playing in this server.',
        ephemeral: true,
      });
    } else {
      return interaction.deferUpdate();
    }
  }

  subscription.audioPlayer.unpause();
  if (interaction instanceof CommandInteraction) {
    await interaction.reply({
      content: 'Unpaused.',
      ephemeral: true,
    });
  } else {
    await interaction.deferUpdate();
  }
}

export async function musicLeave(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<unknown> {
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  const subscription = getSubscription(guild.id);

  if (subscription && current_voice_channel && current_voice_channel?.id !== channel?.id) {
    return interaction.reply({
      content: "You must be on the same channel where I'm currently active to perform this action.",
      ephemeral: true,
    });
  }

  if (!subscription && !current_voice_channel) {
    if (interaction instanceof CommandInteraction) {
      return interaction.reply({
        content: 'Not playing in this server.',
        ephemeral: true,
      });
    } else {
      return interaction.deferUpdate();
    }
  }

  if (subscription) {
    subscription.voiceConnection.destroy();
    deleteSubscription(guild.id);
  } else {
    guild.me?.voice.disconnect();
  }

  await interaction.reply({
    content: 'Disconnected from the channel.',
    ephemeral: true,
  });
}

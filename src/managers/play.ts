import { Collection, Presence } from 'discord.js';
import cron from 'node-cron';
import { client } from '../main.js';
import { getGame, getGatewayConfig, getPlayConfig } from '../modules/database.js';
import { addRole, createRole, deleteRole, removeRole } from '../modules/role.js';
import { logError } from '../modules/telemetry.js';
import { Queuer } from '../utils/queuer.js';
import { ActivityData } from '../utils/types.js';

export const play_prefix = 'Play 🔰';

const queuer = new Queuer();

export async function initPlay(): Promise<void> {
  const clearExpired = async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        const promises = [];
        const play_roles = guild.roles.cache.filter(r => r.name.startsWith(play_prefix));

        for (const play_role of play_roles.values()) {
          for (const member of play_role.members.values()) {
            if (
              !member.presence?.activities.some(
                a => a.type === 'PLAYING' && play_role.name.endsWith(a.name.trim()),
              )
            ) {
              promises.push(removeRole(member, play_role));
            }
          }
          await Promise.all(promises);

          const game_data = await getGame(play_role.name.replace(play_prefix, ''));
          if (play_role.members.size === 0 || (game_data && game_data.status === 'denied')) {
            await deleteRole(play_role);
          }
        }
      }
    } catch (error) {
      logError('Play Manager', 'Clear Expired', error);
    }
  };

  cron.schedule('*/30 * * * *', clearExpired);

  await clearExpired();

  client.on('presenceUpdate', (oldPresence, newPresence) => {
    queuer.queue(() => processPresence(oldPresence, newPresence));
  });
}

async function processPresence(oldPresence: Presence | null, newPresence: Presence): Promise<void> {
  try {
    const guild = newPresence.guild;
    const member = newPresence.member;

    if (!guild || !member || member.user.bot) return;

    // Dont add roles if gateway is enabled and member doesnt have the member role
    const gatewayConfig = await getGatewayConfig(guild.id);
    if (
      gatewayConfig?.enabled &&
      gatewayConfig.role &&
      !member.roles.cache.has(gatewayConfig.role)
    ) {
      return;
    }

    const config = await getPlayConfig(guild.id);
    if (!config || !config.enabled) return;

    const _old = new Collection<string, ActivityData>();
    const _new = new Collection<string, ActivityData>();

    oldPresence?.activities
      .filter(a => a.type === 'PLAYING')
      .forEach(a => {
        _old.set(a.name.trim(), {
          activity: a,
          status: 'old',
        });
      });

    newPresence.activities
      .filter(a => a.type === 'PLAYING')
      .forEach(a => {
        _new.set(a.name.trim(), {
          activity: a,
          status: 'new',
        });
      });

    const diff = _old.difference(_new);
    for (const [game_name, { status }] of diff) {
      const game_data = await getGame(game_name);
      if (game_data && game_data.status === 'approved') {
        const play_name = `${play_prefix}${game_name}`;
        let play_role = guild.roles.cache.find(r => r.name === play_name);

        if (status === 'new') {
          if (play_role) {
            // Update role using reference role
            const reference_role = config.reference_role
              ? guild.roles.cache.get(config.reference_role)
              : undefined;
            if (reference_role) {
              if (reference_role.mentionable !== play_role.mentionable) {
                await play_role.setMentionable(reference_role.mentionable);
              }
              if (reference_role.color !== play_role.color) {
                await play_role.setColor(reference_role.color);
              }
              if (!reference_role.permissions.equals(play_role.permissions)) {
                await play_role.setPermissions(reference_role.permissions);
              }
              await play_role.setPosition(reference_role.position - 1);
            }
          } else {
            play_role = await createRole(guild, {
              name: play_name,
              hoist: config.hoisted,
              mentionable: config.mentionable,
              color: config.reference_role
                ? guild.roles.cache.get(config.reference_role)?.color
                : undefined,
              position: config.reference_role
                ? guild.roles.cache.get(config.reference_role)?.position
                : undefined,
              permissions: config.reference_role
                ? guild.roles.cache.get(config.reference_role)?.permissions
                : undefined,
            });
          }
          if (play_role && !member.roles.cache.has(play_role.id)) await addRole(member, play_role);
        } else if (play_role && member.roles.cache.has(play_role.id)) {
          await removeRole(member, play_role);
        }
      }
    }
  } catch (error) {
    logError('Play Manager', 'Process Presence', error);
  }
}

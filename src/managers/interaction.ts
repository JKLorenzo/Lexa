import { join } from 'path';
import { pathToFileURL } from 'url';
import Discord, {
  BaseMessageComponentOptions,
  Collection,
  CommandInteraction,
  ContextMenuInteraction,
  Guild,
  MessageActionRowOptions,
  MessageComponentInteraction,
} from 'discord.js';
import { client } from '../main.js';
import { logError, logMessage } from '../modules/telemetry.js';
import Command from '../structures/command.js';
import Component from '../structures/component.js';
import { getFiles } from '../utils/functions.js';

const _commands = new Collection<string, Command>();
const _components = new Collection<string, Component>();

export async function initInteraction(): Promise<void> {
  try {
    // Load components
    const components_dir = join(process.cwd(), 'build/components');
    for (const component_path of getFiles(components_dir)) {
      if (!component_path.endsWith('.js')) continue;
      const file_path = pathToFileURL(component_path).href;
      const { default: MessageComponent } = await import(file_path);
      const component = new MessageComponent() as Component;
      _components.set(component.name, component);
      console.log(`component ${component.name} loaded`);
    }
    console.log(`A total of ${_components.size} components were loaded`);

    // Load commands
    const commands_dir = join(process.cwd(), 'build/commands');
    for (const command_path of getFiles(commands_dir)) {
      if (!command_path.endsWith('.js')) continue;
      const file_path = pathToFileURL(command_path).href;
      const { default: ApplicationCommand } = await import(file_path);
      const command = new ApplicationCommand() as Command;
      _commands.set(command.data.name, command);
      console.log(
        `${command.scope} ${`${command.data.type}`.toLowerCase()} command ${
          command.data.name
        } loaded`,
      );
    }
    console.log(`A total of ${_commands.size} commands were loaded`);

    // Initialize commands
    await client.application?.commands.fetch();
    for (const command of _commands.values()) {
      await command.init();
      console.log(
        `${command.scope} ${`${command.data.type}`.toLowerCase()} command ${
          command.data.name
        } initialized`,
      );
    }

    // Delete invalid commands
    const promises = [] as Promise<Discord.ApplicationCommand>[];

    client.application?.commands.cache
      .filter(cmd => !_commands.some(c => c.data.name === cmd.name && c.scope === 'global'))
      .forEach(cmd => promises.push(cmd.delete()));

    client.guilds.cache.forEach(guild =>
      guild.commands.cache
        .filter(cmd => !_commands.some(c => c.data.name === cmd.name && c.scope === 'guild'))
        .forEach(cmd => promises.push(cmd.delete())),
    );

    const deleted_commands = await Promise.all(promises);
    for (const command of deleted_commands) {
      if (command.guildId) {
        logMessage(
          'Interaction Manager',
          `guild ${`${command.type}`.toLowerCase()} command ${command.name} deleted on ${
            command.guild
          }`,
        );
      } else {
        logMessage(
          'Interaction Manager',
          `global ${`${command.type}`.toLowerCase()} command ${command.name} deleted`,
        );
      }
    }
    console.log(`A total of ${deleted_commands.length} commands were deleted`);
  } catch (error) {
    logError('Interaction Manager', 'Initialize', error);
  }

  client.on('interactionCreate', interaction => {
    if (interaction.isCommand() || interaction.isContextMenu()) {
      return processCommand(interaction);
    } else if (interaction.isMessageComponent()) {
      return processComponent(interaction);
    }
  });

  client.on('guildCreate', async guild => {
    for (const command of _commands.values()) {
      await command.init(guild);
    }
  });
}

export async function reloadCommand(name: string, guild?: Guild): Promise<void> {
  try {
    await _commands.get(name)?.init(guild);
  } catch (error) {
    logError('Interaction Manager', 'Reload Command', error);
  }
}

export function getComponent(
  name: string,
): (Required<BaseMessageComponentOptions> & MessageActionRowOptions)[] | undefined {
  return _components.get(name)?.options;
}

async function processCommand(
  interaction: CommandInteraction | ContextMenuInteraction,
): Promise<void> {
  const this_command = _commands.get(interaction.commandName);
  if (!this_command) return;
  try {
    await this_command.exec(interaction);
  } catch (error) {
    logError('Interaction Manager', 'Process Command', error);
  }
}

async function processComponent(interaction: MessageComponentInteraction): Promise<void> {
  const [name, customId] = interaction.customId.split('__');
  const this_component = _components.get(name);
  if (!this_component) return;
  try {
    await this_component.exec(interaction, customId);
  } catch (error) {
    logError('Interaction Manager', 'Process Component', error);
  }
}

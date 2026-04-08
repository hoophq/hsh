import { Command } from "commander";
import { getPlugin, listPlugins } from "../plugins/registry.ts";
import { error, info, keyValue } from "../ui/output.ts";
import chalk from "chalk";

export const pluginCommand = new Command("plugin")
  .description("Manage and run shell plugins");

pluginCommand
  .command("run <name>")
  .description("Run a plugin (used by shell integration)")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (name: string, _opts: unknown, cmd: Command) => {
    const plugin = getPlugin(name);
    if (!plugin) {
      error(`Unknown plugin: ${name}`);
      info("Available plugins:");
      for (const p of listPlugins()) {
        console.log(`  ${chalk.cyan(p.name)} - ${p.description}`);
      }
      process.exit(1);
    }

    // Extract args after "--"
    const rawArgs = process.argv;
    const dashDashIndex = rawArgs.indexOf("--");
    const pluginArgs = dashDashIndex !== -1 ? rawArgs.slice(dashDashIndex + 1) : [];

    await plugin.run(pluginArgs);
  });

pluginCommand
  .command("list")
  .description("List available plugins")
  .action(() => {
    const plugins = listPlugins();
    if (plugins.length === 0) {
      info("No plugins available.");
      return;
    }

    console.log(chalk.bold("\nAvailable plugins:\n"));
    keyValue(
      Object.fromEntries(plugins.map((p) => [p.name, `${p.description} (wraps: ${p.wrappedCommand})`]))
    );
    console.log();
  });

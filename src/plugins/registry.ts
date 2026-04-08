import type { Plugin } from "./base.ts";
import { sshPlugin } from "./ssh.ts";
import { kubectlPlugin } from "./kubectl.ts";

const plugins: Map<string, Plugin> = new Map();

function register(plugin: Plugin): void {
  plugins.set(plugin.name, plugin);
}

// Register built-in plugins
register(sshPlugin);
register(kubectlPlugin);

export function getPlugin(name: string): Plugin | undefined {
  return plugins.get(name);
}

export function listPlugins(): Plugin[] {
  return Array.from(plugins.values());
}

export function getWrappedCommands(): { command: string; plugin: string }[] {
  return Array.from(plugins.values()).map((p) => ({
    command: p.wrappedCommand,
    plugin: p.name,
  }));
}

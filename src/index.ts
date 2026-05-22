#!/usr/bin/env bun
import { program } from "commander";
import { loginCommand } from "./commands/login.ts";
import { logoutCommand } from "./commands/logout.ts";
import { statusCommand } from "./commands/status.ts";
import { configCommand } from "./commands/config.ts";
import { kubeconfigCommand } from "./commands/kubeconfig.ts";
import { shellInitCommand } from "./commands/shell-init.ts";
import { pluginCommand } from "./commands/plugin.ts";
import { tunnelCommand } from "./commands/tunnel.ts";
import { updateCommand } from "./commands/update.ts";
import { VERSION } from "./version.ts";

program
  .name("hsh")
  .description("Hoop Shell Plugins — Seamless access to infrastructure via shell integration")
  .version(VERSION);

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(statusCommand);
program.addCommand(configCommand);
program.addCommand(kubeconfigCommand);
program.addCommand(shellInitCommand);
program.addCommand(pluginCommand);
program.addCommand(tunnelCommand);
program.addCommand(updateCommand);

program.parse();

#!/usr/bin/env bun
import { program } from "commander";
import { loginCommand } from "./commands/login.ts";
import { logoutCommand } from "./commands/logout.ts";
import { statusCommand } from "./commands/status.ts";
import { configCommand } from "./commands/config.ts";
import { shellInitCommand } from "./commands/shell-init.ts";
import { pluginCommand } from "./commands/plugin.ts";

program
  .name("hsh")
  .description("Hoop Shell Plugins — Seamless access to infrastructure via shell integration")
  .version("0.1.0");

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(statusCommand);
program.addCommand(configCommand);
program.addCommand(shellInitCommand);
program.addCommand(pluginCommand);

program.parse();

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
import { dashboardCommand } from "./commands/dashboard.ts";
import { VERSION } from "./version.ts";
import { BUNDLED_DAEMON_VERSION } from "./daemon-version-stamp.ts";

// `--version` shows both hsh's own version and the bundled
// hsh-tunneld version. Commander's --version format is single-line,
// so we use "/" to separate the two values; tooling that wants to
// parse it can rely on the first whitespace-delimited token being
// hsh's semver string.
program
  .name("hsh")
  .description("Hoop Shell Plugins — Seamless access to infrastructure via shell integration")
  .version(`${VERSION} (hsh-tunneld ${BUNDLED_DAEMON_VERSION})`);

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(statusCommand);
program.addCommand(configCommand);
program.addCommand(kubeconfigCommand);
program.addCommand(shellInitCommand);
program.addCommand(pluginCommand);
program.addCommand(tunnelCommand);
program.addCommand(dashboardCommand);
program.addCommand(updateCommand);

program.parse();

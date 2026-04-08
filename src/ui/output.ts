import chalk from "chalk";
import boxen from "boxen";
import ora, { type Ora } from "ora";

export function success(message: string): void {
  console.log(chalk.green(`✓ ${message}`));
}

export function error(message: string): void {
  console.error(chalk.red(`✗ ${message}`));
}

export function warn(message: string): void {
  console.log(chalk.yellow(`⚠ ${message}`));
}

export function info(message: string): void {
  console.log(chalk.blue(`→ ${message}`));
}

export function dim(message: string): void {
  console.log(chalk.dim(message));
}

export function bold(message: string): string {
  return chalk.bold(message);
}

export function tokenBox(opts: {
  title: string;
  connection: string;
  token: string;
  instructions?: string;
}): void {
  const lines = [
    "",
    chalk.bold(opts.title),
    "",
    `${chalk.dim("Connection:")} ${chalk.cyan(opts.connection)}`,
    `${chalk.dim("Token:")}      ${chalk.green(opts.token)}`,
    "",
    chalk.dim(opts.instructions ?? "Copy this token when prompted"),
    "",
  ];

  console.log(
    boxen(lines.join("\n"), {
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      borderColor: "cyan",
      borderStyle: "round",
    })
  );
}

export function spinner(text: string): Ora {
  return ora({ text, color: "cyan" }).start();
}

export function keyValue(pairs: Record<string, string>): void {
  const maxKeyLen = Math.max(...Object.keys(pairs).map((k) => k.length));
  for (const [key, value] of Object.entries(pairs)) {
    const paddedKey = key.padEnd(maxKeyLen);
    console.log(`  ${chalk.dim(paddedKey)}  ${value}`);
  }
}

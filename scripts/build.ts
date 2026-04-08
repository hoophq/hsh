#!/usr/bin/env bun
import { $ } from "bun";
import { mkdirSync, existsSync } from "fs";

const targets = [
  { name: "hsh-linux-x64", target: "bun-linux-x64" },
  { name: "hsh-linux-arm64", target: "bun-linux-arm64" },
  { name: "hsh-darwin-x64", target: "bun-darwin-x64" },
  { name: "hsh-darwin-arm64", target: "bun-darwin-arm64" },
  { name: "hsh-windows-x64.exe", target: "bun-windows-x64" },
] as const;

const distDir = "dist";

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

console.log("Building hsh for all platforms...\n");

for (const { name, target } of targets) {
  const outfile = `${distDir}/${name}`;
  console.log(`  Building ${name} (${target})...`);
  try {
    await $`bun build --compile --target=${target} src/index.ts --outfile ${outfile}`.quiet();
    console.log(`  ✓ ${outfile}`);
  } catch (err) {
    console.error(`  ✗ Failed to build ${name}: ${err}`);
  }
}

console.log("\nDone!");

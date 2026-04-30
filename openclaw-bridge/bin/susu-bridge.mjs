#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "index.ts");

const candidates = [join(homedir(), ".bun", "bin", "bun"), "bun"];
const bun = candidates.find((p) => p === "bun" || existsSync(p)) ?? "bun";

const child = spawn(bun, ["run", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));

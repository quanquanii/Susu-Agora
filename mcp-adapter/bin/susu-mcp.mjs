#!/usr/bin/env node
// Dev shim — same approach as cli/bin/susu.mjs. Spawns bun on the TS entry
// so we don't have to ship a build step for now. Production npm publish
// will replace this with a bundled ESM file.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "server.ts");

const candidates = [join(homedir(), ".bun", "bin", "bun"), "bun"];
const bun = candidates.find((p) => p === "bun" || existsSync(p)) ?? "bun";

const child = spawn(bun, ["run", entry], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));

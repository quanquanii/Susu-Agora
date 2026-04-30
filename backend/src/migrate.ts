// Minimal migration runner. Reads migrations/*.sql in lexical order,
// skips ones already in schema_migrations, applies the rest in a tx.

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "./config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

async function main() {
  const sql = postgres(config.databaseUrl, { max: 1, idle_timeout: 5 });

  try {
    // Bootstrap: create schema_migrations if it doesn't exist. Done outside
    // the per-file transaction since CREATE EXTENSION + CREATE TABLE in
    // 001_init.sql also creates this table — but for subsequent migrations
    // we want to skip files already applied without re-running 001.
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

    const applied = await sql<{ version: string }[]>`SELECT version FROM schema_migrations`;
    const appliedSet = new Set(applied.map((r) => r.version));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ran = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (appliedSet.has(version)) {
        console.log(`  skip  ${version} (already applied)`);
        continue;
      }
      const fullPath = join(MIGRATIONS_DIR, file);
      const body = await readFile(fullPath, "utf8");
      console.log(`  apply ${version}`);
      // Each file is responsible for its own INSERT into schema_migrations
      // at the end, so we can run the whole body in one tx via unsafe()
      // (postgres.js requires unsafe() for multi-statement strings).
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
      });
      ran++;
    }
    console.log(`migrations: ${ran} applied, ${appliedSet.size} skipped`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});

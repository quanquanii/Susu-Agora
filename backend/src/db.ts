import postgres from "postgres";
import { config } from "./config.ts";

// Single shared connection pool. Bun keeps the process alive, so we keep
// the pool small and let postgres.js handle reconnect/idle.
export const sql = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  // Keep JSON/JSONB as parsed objects, not strings.
  types: {},
});

// Querier accepts either the top-level Sql or a TransactionSql passed inside
// sql.begin(...). All helper functions in lib/* take this shape — they only
// need the tagged-template call signature and the .json() helper.
export type Querier = typeof sql | postgres.TransactionSql<{}>;

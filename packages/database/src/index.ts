import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { loadRepoEnv } from "./env.js";

export * from "./schema.js";

// #62: honor the repo-root .env before falling back to the default DSN, so
// db/CLI commands can never silently run against the live database when a
// different DATABASE_URL is configured. Real env vars still win.
loadRepoEnv();

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://tax:tax_dev_only@localhost:5433/agent_tax_research";

const client = postgres(connectionString);

export const db = drizzle(client, { schema });

export { client };

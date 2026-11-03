import { client } from "./index.js";

// Fresh-database bootstrap (#44): extensions the schema needs must exist
// before drizzle-kit runs. Docker init (db/init) covers first volume
// init only; second databases, CI, and Azure Database for PostgreSQL
// never see it. Idempotent — safe on every migrate.
await client`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
await client`CREATE EXTENSION IF NOT EXISTS vector`;
await client.end();
console.log("extensions ready: pgcrypto, vector");

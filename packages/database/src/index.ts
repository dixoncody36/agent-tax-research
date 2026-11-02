import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://tax:tax_dev_only@localhost:5433/agent_tax_research";

const client = postgres(connectionString);

export const db = drizzle(client, { schema });

export { client };

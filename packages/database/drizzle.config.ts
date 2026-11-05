import { defineConfig } from "drizzle-kit";
import { loadRepoEnv } from "./src/env.js";

// #62: same .env resolution as src/index.ts — drizzle-kit runs from this
// package dir, so the walk-up finds the repo-root .env.
loadRepoEnv();

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://tax:tax_dev_only@localhost:5433/agent_tax_research",
  },
});

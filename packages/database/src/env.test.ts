import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findEnvFile, loadRepoEnv } from "./env.js";

// Regression suite for #62: db/CLI entry points ignored the repo-root .env
// and fell back to the live database name, so a scratch DATABASE_URL in .env
// silently ran migrate/seed against the live DB.
const KEY = "DATABASE_URL";

function scratchTree(): { root: string; nested: string } {
  const root = mkdtempSync(join(tmpdir(), "atr-env-"));
  const nested = join(root, "packages", "database");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, ".env"), `${KEY}=postgres://tax:x@localhost:5433/scratch_db\nOTHER=1\n`, "utf8");
  return { root, nested };
}

describe("findEnvFile", () => {
  it("walks up from a nested package dir to the repo root .env", () => {
    const { root, nested } = scratchTree();
    assert.equal(findEnvFile(nested), join(root, ".env"));
  });
  it("returns null when no .env exists up the tree", () => {
    const empty = mkdtempSync(join(tmpdir(), "atr-env-empty-"));
    assert.equal(findEnvFile(empty), null);
  });
});

describe("loadRepoEnv (#62)", () => {
  it("loads DATABASE_URL from .env when the real env does not set it", () => {
    const { nested } = scratchTree();
    const before = process.env[KEY];
    delete process.env[KEY];
    try {
      const loaded = loadRepoEnv(nested);
      assert.ok(loaded);
      assert.equal(process.env[KEY], "postgres://tax:x@localhost:5433/scratch_db");
    } finally {
      delete process.env[KEY];
      delete process.env.OTHER;
      if (before !== undefined) process.env[KEY] = before;
    }
  });
  it("a real environment variable wins over the .env value", () => {
    const { nested } = scratchTree();
    const before = process.env[KEY];
    process.env[KEY] = "postgres://tax:x@localhost:5433/real_env_db";
    try {
      loadRepoEnv(nested);
      assert.equal(process.env[KEY], "postgres://tax:x@localhost:5433/real_env_db");
    } finally {
      delete process.env.OTHER;
      if (before === undefined) delete process.env[KEY];
      else process.env[KEY] = before;
    }
  });
  it("missing .env is a no-op, never a throw", () => {
    const empty = mkdtempSync(join(tmpdir(), "atr-env-none-"));
    assert.equal(loadRepoEnv(empty), null);
  });
});

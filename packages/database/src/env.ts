import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Repo-root .env loading (#62). db/CLI entry points previously read only
// process.env with a hard fallback to the live database name, so a custom
// DATABASE_URL in .env was silently ignored and commands hit the live DB.
// Resolution order: real environment variable (never overridden) > .env
// found by walking up from the start dir > caller-side fallback.
// ponytail: naive KEY=VALUE parse (quotes stripped), same as the providers.ts
// loader — promote both to one shared env module if a third consumer needs
// full dotenv semantics. No new dependency for this.

export function findEnvFile(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Loads the nearest .env at or above startDir. An explicit startDir is
// authoritative (searched alone); with none, INIT_CWD then cwd are tried.
// Returns the file loaded, or null when none exists. Never throws on a
// missing file; malformed lines are skipped.
export function loadRepoEnv(startDir?: string): string | null {
  const starts = startDir
    ? [startDir]
    : ([process.env.INIT_CWD, process.cwd()].filter(Boolean) as string[]);
  for (const start of starts) {
    const file = findEnvFile(start);
    if (!file) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]!] === undefined) {
        process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
      }
    }
    return file;
  }
  return null;
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

export const dynamic = "force-dynamic";
const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Retry a failed run by shelling out to `tax work retry` — the CLI is the
// single writer, so the three-attempt cap and status checks apply unchanged.
// It queues the next attempt; a worker (tax work run) picks it up.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "invalid run id" }, { status: 400 });
  const repoRoot = path.resolve(process.cwd(), "..", "..");
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  try {
    const { stdout } = await run(pnpm, ["-s", "tax", "work", "retry", "--id", id], { cwd: repoRoot, shell: process.platform === "win32", timeout: 60000 });
    return Response.json({ ok: true, result: JSON.parse(stdout) });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    let message = e.stdout || e.stderr || e.message;
    try { message = (JSON.parse(e.stdout ?? "") as { error?: string }).error ?? message; } catch { /* not JSON: keep raw text */ }
    return Response.json({ error: message }, { status: 409 });
  }
}

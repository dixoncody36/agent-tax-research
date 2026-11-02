import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

export const dynamic = "force-dynamic";
const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Human actions shell out to the tax CLI — the single writer path. The web
// layer never writes canonical rows directly; the CLI + DB gates (distinct
// extractor/verifier/approver, eligible sources) apply unchanged.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "invalid proposal id" }, { status: 400 });
  const body = (await req.json()) as { action?: string; approvedBy?: string };
  const action = body.action;
  const approvedBy = (body.approvedBy ?? "").trim();
  if (action !== "approve" && action !== "publish") {
    return Response.json({ error: "action must be approve|publish" }, { status: 400 });
  }
  if (action === "approve" && approvedBy.length < 3) {
    return Response.json({ error: "a human approver name is required" }, { status: 400 });
  }
  const repoRoot = path.resolve(process.cwd(), "..", "..");
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = action === "approve"
    ? ["tax", "proposal", "approve", "--id", id, "--approved-by", approvedBy]
    : ["tax", "proposal", "publish", "--id", id];
  try {
    const { stdout } = await run(pnpm, args, { cwd: repoRoot, shell: process.platform === "win32", timeout: 120000 });
    return Response.json({ ok: true, result: JSON.parse(stdout) });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return Response.json({ error: e.stdout || e.stderr || e.message }, { status: 409 });
  }
}

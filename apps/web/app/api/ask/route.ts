import { ask } from "../../../lib/ask";

export const dynamic = "force-dynamic";

// GET /api/ask?q=<question> -> { interpretation, answer, evidence[] } (B3).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) return Response.json({ error: "q is required" }, { status: 400 });
  try {
    return Response.json(await ask(q, url.origin));
  } catch (e) {
    return Response.json({ error: `ask failed: ${String(e)}` }, { status: 500 });
  }
}

You are the UI redesign worker for agent-tax-research (operator brief, 2026-11-03). Another agent session is working data expansion in the main checkout in parallel — do NOT edit files there.

FIRST, isolate yourself:
  git worktree add ../agent-tax-research.worktrees/ui-redesign -b feat/ui-redesign milestone-8-geolocation-boundaries
  cd ../agent-tax-research.worktrees/ui-redesign
All your work happens in that worktree on branch feat/ui-redesign. Commit there (conventional commits), push only that branch. Never touch milestone branches, never merge.

Read yourself in (pointers, read the files):
- AGENTS.md (project rules), .claude/project-manifest.json (state)
- apps/web/app/page.tsx, apps/web/app/Globe.tsx, apps/web/app/globals.css, apps/web/app/review/page.tsx
- Live app for reference: http://localhost:3100 (already running from main checkout; do not restart it — run your own dev server on port 3102 from your worktree when you need one)

Redesign brief — the whole web UI (globe home + review queue):
1. It is a demo today for a Nov 4 submission. Make it look like a serious A&M Tax product: strong hierarchy, generous contrast, polished panels/typography/spacing. Keep the dark globe-first concept.
2. Brand (028): Navy #002B49 + Medium Blue #5E8AB4 dominant, Bright Blue #0085CA accents, Arial only, never red as a brand color (existing semantic error/blocked reds may stay semantic).
3. Preserve every behavior and contract: routes, API shapes, all data-testids (geo-lookup, geo-result, globe-zoom-in, globe-zoom-out, globe-focus-texas, globe-reset, approve-hint), approveGate logic in apps/web/app/review/approveGate.ts, globe interactions (drag/scroll/pinch/dblclick zoom, Focus Texas, click select + click point lookup, level-of-detail markers/boundaries). Redesign presentation, not semantics.
4. Standards: no new top-level dependencies without stopping to flag it; no Radix, no Remix Icon; if icons are needed use inline SVG or text glyphs already present. Plain-CSS evolution of the existing style is fine (this app predates the factory stamp; do not shadcn-init).
5. Field sense: stats/legend ordering stays lifecycle-ranked, numbers formatted with toLocaleString, coordinates range-validated as today.
6. Verify: pnpm --filter @agent-tax-research/web typecheck and build green; run your worktree dev server on 3102 and load / and /review (200s, no console-breaking errors you can see in server log).

Deliverable: commits on feat/ui-redesign + a pushed branch, then a final summary in this pane: what changed visually (before/after in words), how to view it (command + URL on port 3102), test evidence, and anything you deliberately did not change. End your final message with the line: UI dash REDESIGNED (write dash as a hyphen character).


Brand addendum (decision 028, verified against brand_spec): topbar carries the approved A&M Tax WHITE logo on dark (source: C:\Users\COdy.dixon\.config\muse\skills\anvil-brand\assets\logos\AMTax_White.png — copy it into your worktree at apps/web/public/amtax-white.png via shell cp, never recolor/stretch, aspect ~2.71:1), tagline Leadership.Action.Results. in plain text, and a visible DRAFT tag in the topbar (client-facing deliverable rule). Dark Gray #646464 is the body-gray reference; on dark surfaces use light ink for contrast.

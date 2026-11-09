// The anti-hallucination gate shared by the headless Fetch, Decision, and
// Reviewer handlers: a model-quoted excerpt counts as evidence only when it
// appears verbatim in the stored snapshot text. Whitespace and case are
// normalized (snapshot text is already whitespace-collapsed); nothing else.

const MIN_EXCERPT_CHARS = 12;

export function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function verbatimIn(excerpt: unknown, snapshotText: string): boolean {
  if (typeof excerpt !== "string") return false;
  const needle = normalizeForMatch(excerpt);
  // A too-short quote ("6.25%") matches almost anywhere and proves nothing.
  if (needle.length < MIN_EXCERPT_CHARS) return false;
  return normalizeForMatch(snapshotText).includes(needle);
}

/** Model input: the head of a snapshot, with the cut stated so the model never assumes completeness. */
export function snapshotWindow(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[snapshot truncated at ${maxChars} of ${text.length} chars]`;
}

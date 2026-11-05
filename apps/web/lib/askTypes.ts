// Client-safe types and constants for the Ask surface (no server imports).
export type Intent = "rate" | "exists" | "which" | "coords" | "unknown";
export type Flag = { level: "partial" | "unknown" | "info"; text: string };
export type Evidence = { title: string; url: string | null; citation: string | null; snapshotAt: string | null };
export type AskResult = {
  interpretation: {
    question: string; intent: Intent; parsedBy: "deterministic";
    jurisdiction: { slug: string; name: string; level: string } | null; alsoMatches: { slug: string; name: string; level: string }[];
    taxTypes: { slug: string; name: string }[]; taxScope: "specific" | "category" | "none";
    asOf: string; coordinates: { lat: number; lng: number } | null; notes: string[];
  };
  answer: { kind: "answer" | "unknown" | "not_understood"; headline: string; rows: { label: string; value: string; detail?: string }[]; flags: Flag[]; combinedPercent?: number };
  evidence: Evidence[];
};

export const EXAMPLES = [
  "What is the sales tax rate in Austin?",
  "What is the Texas state sales tax rate?",
  "What is the HST rate in Ontario?",
  "Does Austin have a hotel occupancy tax?",
  "Does Texas have a franchise tax?",
  "Which jurisdictions levy a hotel occupancy tax?",
  "Rate at 30.2672, -97.7431",
];

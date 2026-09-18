/**
 * The series palette: low-saturation grays with a whisper of hue, so adjacent series stay
 * distinguishable without breaking the AMOLED monochrome theme. NO bright / saturated hues.
 * Cycles. (Moved from the old Console's chart-theme.ts; the ordering is unchanged.)
 */
const SERIES_PALETTE = [
  "#cfcfd4", // light gray
  "#9aa3ad", // slate
  "#a8b0a3", // sage-gray
  "#b3aa9e", // warm gray
  "#a39fb0", // mauve-gray
  "#8f96a0", // cool gray
  "#bdb6ab", // sand-gray
  "#9bb0aa", // muted teal-gray
  "#b0a6b3", // dusty lilac-gray
  "#878d92", // graphite
] as const;

export function seriesColor(index: number): string {
  return SERIES_PALETTE[index % SERIES_PALETTE.length];
}

/** The tint the "Other" bucket draws in — quieter than any named series. */
export const OTHER_COLOR = "#4a4d52";

/**
 * The house's per-agent chip colours, keyed by the family a MODEL belongs to.
 *
 * These are `tokens.css`'s `--agent-*-chip` pairs, used here so a model chip
 * carries the colour its vendor already has everywhere else in the app rather
 * than a fourth palette invented for this table. Claude's takes the raw
 * terracotta token rather than the `.agent-claude` class, which resolves to
 * white — correct for a brand badge next to a brand glyph, too quiet for a
 * chip that has to be told apart from its neighbours at a glance.
 */
export interface Tint {
  fg: string;
  bg: string;
}

const TINTS: Record<string, Tint> = {
  claude: { fg: "var(--agent-claude-chip)", bg: "var(--agent-claude-chip-bg)" },
  codex: { fg: "var(--agent-codex-chip)", bg: "var(--agent-codex-chip-bg)" },
  gemini: { fg: "var(--agent-gemini-chip)", bg: "var(--agent-gemini-chip-bg)" },
  local: { fg: "var(--agent-local-chip)", bg: "var(--agent-local-chip-bg)" },
  cursor: { fg: "var(--agent-cursor-chip)", bg: "var(--agent-cursor-chip-bg)" },
  kilo: { fg: "var(--agent-kilo-chip)", bg: "var(--agent-kilo-chip-bg)" },
};

const NEUTRAL: Tint = { fg: "var(--text-tertiary)", bg: "var(--bg-raised)" };

/** The tint a model id wears. Falls back to neutral rather than guessing. */
export function modelTint(model: string): Tint {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(m)) return TINTS.claude;
  if (/gpt|codex|\bo[134]\b/.test(m)) return TINTS.codex;
  if (/gemini|palm/.test(m)) return TINTS.gemini;
  if (/llama|mistral|qwen|deepseek|phi|gemma/.test(m)) return TINTS.local;
  if (/cursor/.test(m)) return TINTS.cursor;
  if (/kilo/.test(m)) return TINTS.kilo;
  return NEUTRAL;
}

/** The tint an agent wears in a table cell, by the same families. */
export function agentTint(agent: string): Tint {
  const a = agent.toLowerCase();
  if (a.includes("claude")) return TINTS.claude;
  if (a.includes("codex") || a.includes("cersei")) return TINTS.codex;
  if (a.includes("cursor")) return TINTS.cursor;
  if (a.includes("kilo")) return TINTS.kilo;
  return NEUTRAL;
}

/**
 * The first-party agents' own brand hues.
 *
 * NOT theme keys, deliberately. There used to be eighteen — `agent.claude.*`,
 * `agent.gpt.*`, `agent.gemini.*`, `agent.amp.*` and so on — and eight of them
 * named agents that do not exist in Atlas, while three more were overridden by
 * hardcoded CSS before they ever rendered. Two things make the whole family
 * wrong as a theme surface:
 *
 *  - **ADR-0002.** No agent gets special treatment. A theme file that can name
 *    Claude and Cursor but not the agent you installed this morning is a list
 *    of favourites.
 *  - **The set is discovered at runtime.** An author cannot enumerate what they
 *    are theming, so the keys could never be complete.
 *
 * What is left is `agent.chip.foreground` / `agent.chip.background`: one
 * neutral pair the chip falls back to, which is what lets a monochrome theme
 * (Atlas Mono, Vesper) flatten every identity to its own palette. These
 * constants are the vendors' marks — a third party's colour, not Atlas's, and
 * not something a theme should be able to restate.
 */
import type { FirstPartyAgent } from "@/types/agent";

/**
 * Brand colour per first-party identity, or `null` where the mark carries its
 * own colours (Atlas's native agent draws `AtlasIcon`) and the glyph must not
 * be tinted at all.
 */
const BRAND: Record<FirstPartyAgent, string | null> = {
  "claude-code": "#c98263",
  codex: "#10a37f",
  opencode: "#9ca3af",
  cursor: "#d9b56e",
  kilo: "#f0c53d",
  cersei: null,
};

/**
 * The tint for an agent's brand mark, or `undefined` to leave it inheriting
 * the surrounding colour — which is also what an external agent gets, since
 * its icon comes from its own manifest SVG.
 */
export function agentBrandColor(id: string): string | undefined {
  for (const [agent, color] of Object.entries(BRAND)) {
    if (color && id.includes(agent === "claude-code" ? "claude" : agent)) return color;
  }
  return undefined;
}

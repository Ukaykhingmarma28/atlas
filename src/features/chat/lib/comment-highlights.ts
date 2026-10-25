/**
 * The commented passage, marked in the prose it was selected from.
 *
 * Drawn with the CSS Custom Highlight API (`CSS.highlights`, `::highlight()`):
 * a set of DOM ranges painted by a stylesheet rule, with no element wrapped
 * and no markup touched. That is the whole reason it is used — the prose is
 * the markdown cache's DOM, and splitting its text nodes to wrap a `<mark>`
 * would fight every re-render and break the cache's identity. A WebKit
 * without the API (macOS before 14.2) draws no highlight and loses nothing
 * else: the thread under the row still quotes the passage.
 *
 * One registry per highlight name, keyed by owner (a row), so each row adds
 * and removes its own ranges without knowing about the others.
 */

export const COMMENT_HIGHLIGHT = "atlas-comment";
export const DRAFT_HIGHLIGHT = "atlas-comment-draft";

const SKIP = new Set(["SCRIPT", "STYLE", "BUTTON", "TEXTAREA"]);

interface TextIndex {
  /** Every text node's characters, concatenated, whitespace runs collapsed. */
  text: string;
  /** For each character of `text`, the node and offset it came from. */
  nodes: Text[];
  offsets: number[];
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === " ";
}

/** The text of `root` as one string with every whitespace run one space,
 *  and a way back from each character to its node. */
export function indexText(root: Node): TextIndex {
  const nodes: Text[] = [];
  const offsets: number[] = [];
  let text = "";
  let pendingSpace = false;
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      for (let i = 0; i < data.length; i++) {
        if (isWhitespace(data[i])) {
          pendingSpace = true;
          continue;
        }
        if (pendingSpace && text.length > 0) {
          text += " ";
          nodes.push(node as Text);
          offsets.push(i);
        }
        pendingSpace = false;
        text += data[i];
        nodes.push(node as Text);
        offsets.push(i);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP.has(el.tagName)) return;
    // A block boundary is whitespace, as a selection's `toString` writes it.
    if (text.length > 0) pendingSpace = true;
    for (let child = el.firstChild; child; child = child.nextSibling) walk(child);
    pendingSpace = true;
  };
  walk(root);
  return { text, nodes, offsets };
}

function normalize(passage: string): string {
  return passage.replace(/\s+/g, " ").trim();
}

/** The first run of `passage` inside `root`, as a DOM range, or null. */
export function findPassageRange(root: Node, passage: string, index?: TextIndex): Range | null {
  const needle = normalize(passage);
  if (!needle) return null;
  const idx = index ?? indexText(root);
  const at = idx.text.indexOf(needle);
  if (at < 0) return null;
  const end = at + needle.length - 1;
  const range = document.createRange();
  range.setStart(idx.nodes[at], idx.offsets[at]);
  range.setEnd(idx.nodes[end], idx.offsets[end] + 1);
  return range;
}

type HighlightsApi = {
  highlights: {
    get(name: string): HighlightLike | undefined;
    set(name: string, highlight: HighlightLike): void;
    delete(name: string): void;
  };
};
interface HighlightLike {
  add(range: Range): void;
  delete(range: Range): void;
  clear(): void;
}
declare const Highlight: { new (...ranges: Range[]): HighlightLike } | undefined;

function api(): HighlightsApi["highlights"] | null {
  const css = (globalThis as { CSS?: Partial<HighlightsApi> }).CSS;
  return css?.highlights && typeof Highlight !== "undefined" ? css.highlights : null;
}

export function highlightsSupported(): boolean {
  return api() !== null;
}

const registry = new Map<string, Map<object, Range[]>>();

/** Make `owner`'s ranges under `name` exactly `ranges`. */
export function setHighlightRanges(name: string, owner: object, ranges: readonly Range[]): void {
  const highlights = api();
  if (!highlights) return;
  let owners = registry.get(name);
  if (!owners) {
    owners = new Map();
    registry.set(name, owners);
  }
  if (ranges.length === 0) owners.delete(owner);
  else owners.set(owner, [...ranges]);
  if (owners.size === 0) {
    highlights.delete(name);
    registry.delete(name);
    return;
  }
  const all: Range[] = [];
  for (const rs of owners.values()) all.push(...rs);
  highlights.set(name, new Highlight!(...all));
}

export function clearHighlightRanges(name: string, owner: object): void {
  setHighlightRanges(name, owner, []);
}

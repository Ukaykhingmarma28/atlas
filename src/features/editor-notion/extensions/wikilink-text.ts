import { Node } from "@tiptap/core";

/**
 * The editor's text node, replacing StarterKit's so `[[page-id]]` wikilinks
 * survive a save.
 *
 * tiptap-markdown serializes text through prosemirror-markdown's `esc()`,
 * which backslash-escapes every `[` and `]`. A note containing
 * `[[roadmap-q4]]` was therefore saved as `\[\[roadmap-q4\]\]`, which the
 * Rust link index (`find_refs` in `commands/knowledge_links.rs`) does not
 * recognise — so saving a note silently dropped all its wikilinks.
 *
 * Everything is still escaped exactly as before; complete wikilinks the index
 * would accept (non-empty, single line, under 200 bytes) are then restored
 * verbatim. A wikilink followed by `(` stays escaped, since `[[x]](url)`
 * would parse back as a link.
 */

// `\[\[` … `\]\]` in already-escaped text, not followed by `(`.
const ESCAPED_WIKILINK = /\\\[\\\[((?:(?!\\\]\\\]).)+?)\\\]\\\](?!\()/g;
const ESCAPED_CHAR = /\\([`*\\~[\]_])/g;
const MAX_TARGET_BYTES = 200;

/** Undo `esc()` on complete wikilinks in one escaped line. */
export function restoreWikilinks(escaped: string): string {
  return escaped.replace(ESCAPED_WIKILINK, (match, inner: string) => {
    const target = inner.replace(ESCAPED_CHAR, "$1");
    if (new TextEncoder().encode(target).length >= MAX_TARGET_BYTES) return match;
    return `[[${target}]]`;
  });
}

// tiptap-markdown's own text serializer runs this first (util/dom.js).
function escapeHTML(value: string) {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface SerializerState {
  atBlockStart: boolean;
  esc(text: string, startOfLine?: boolean): string;
  text(text: string, escape?: boolean): void;
}

export const WikilinkText = Node.create({
  name: "text",
  group: "inline",

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: { text?: string }) {
          const text = escapeHTML(node.text ?? "");
          if (!text.includes("[[")) {
            state.text(text);
            return;
          }
          // Mirror `state.text(text)`: each line escaped with the same
          // start-of-line flag, then written without a second escape pass.
          const escaped = text
            .split("\n")
            .map((line) => restoreWikilinks(state.esc(line, state.atBlockStart)))
            .join("\n");
          state.text(escaped, false);
        },
        parse: {
          // handled by markdown-it
        },
      },
    };
  },
});

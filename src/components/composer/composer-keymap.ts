// A composer's keys: send, newline, list continuation, list indent, Escape.
// History (⌘Z / ⇧⌘Z / ⌘Y) is StarterKit's undo/redo, configured in
// `composer-editor.tsx`.
//
//   Enter          send when `enterToSend`, else a newline that continues a
//                  list (`- `, `* `, `1. `, `- [ ] `) or a quote (`> `).
//   Shift+Enter    a plain newline.
//   ⌘/Ctrl+Enter   send, always.
//   Tab / ⇧Tab     indent / outdent a list line by two spaces; elsewhere the
//                  browser's own Tab, so focus can still leave the field.
//   Escape         the feature's `onEscape`, if it gives one.
//
// An Enter on an empty list item ends the list instead of starting another
// one (outdenting first when the item is nested), the way the CodeMirror
// composer's markdown keymap did. Lines are paragraphs (`composer-doc.ts`), so
// every rule here reads and writes one paragraph's text.
//
// Priority sits below `ComposerTriggers`, so an open picker gets Enter, Tab
// and Escape first.

import { Extension, type Editor } from "@tiptap/core";
import { splitBlock } from "@tiptap/pm/commands";
import type { EditorState, Transaction } from "@tiptap/pm/state";

export interface ComposerKeymapOptions {
  /** Read live, so the setting applies without rebuilding the editor. */
  getEnterToSend: () => boolean;
  onSubmit: () => void;
  /** Return true when Escape did something. */
  onEscape: (() => boolean) | null;
}

const LEAF_CHAR = "￼";
const LIST = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
const QUOTE = /^(\s*>\s?)/;
const INDENT = "  ";

function currentLine(state: EditorState): { text: string; start: number; offset: number } | null {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return null;
  const parent = $from.parent;
  return {
    text: parent.textBetween(0, parent.content.size, undefined, LEAF_CHAR),
    start: $from.start(),
    offset: $from.parentOffset,
  };
}

/** Newline that carries a list or quote marker onto the next line. Returns
 *  false (and does nothing) when the caret is not on such a line. */
export function continueMarkup(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
  if (!state.selection.empty) return false;
  const line = currentLine(state);
  if (!line) return false;
  let prefix: string;
  let next: string;
  let indent = "";
  const list = LIST.exec(line.text);
  const quote = list ? null : QUOTE.exec(line.text);
  if (list) {
    const [whole, lead, bullet, num, delim, space, task] = list;
    prefix = whole;
    indent = lead;
    next = `${lead}${bullet ?? `${Number(num) + 1}${delim}`}${space}${task ? "[ ] " : ""}`;
  } else if (quote) {
    prefix = quote[1];
    next = quote[1];
  } else {
    return false;
  }
  // Caret inside the marker itself: a plain newline is what the user means.
  if (line.offset < prefix.length) return false;
  const tr = state.tr;
  if (line.text.slice(prefix.length).trim() === "") {
    // Empty item: outdent a nested one, end a top-level one.
    if (indent.length >= INDENT.length) {
      tr.delete(line.start, line.start + INDENT.length);
    } else {
      tr.delete(line.start, line.start + line.text.length);
    }
    dispatch(tr.scrollIntoView());
    return true;
  }
  tr.split(state.selection.from).insertText(next);
  dispatch(tr.scrollIntoView());
  return true;
}

function isListLine(state: EditorState): boolean {
  const line = currentLine(state);
  return !!line && LIST.test(line.text);
}

function indentLine(editor: Editor, out: boolean): boolean {
  const { state, view } = editor;
  if (!isListLine(state)) return false;
  const line = currentLine(state)!;
  if (out) {
    const lead = /^ {1,2}/.exec(line.text)?.[0].length ?? 0;
    if (lead > 0) view.dispatch(state.tr.delete(line.start, line.start + lead));
  } else {
    view.dispatch(state.tr.insertText(INDENT, line.start));
  }
  // Swallowed either way on a list line: Tab must not move focus out of the
  // field halfway through a list.
  return true;
}

function newline(editor: Editor, continueLists: boolean): boolean {
  const { state, view } = editor;
  const dispatch = (tr: Transaction) => view.dispatch(tr.scrollIntoView());
  if (continueLists && continueMarkup(state, dispatch)) return true;
  return splitBlock(state, dispatch);
}

export const ComposerKeymap = Extension.create<ComposerKeymapOptions>({
  name: "atlasComposerKeymap",
  priority: 900,

  addOptions() {
    return { getEnterToSend: () => true, onSubmit: () => {}, onEscape: null };
  },

  addKeyboardShortcuts() {
    const guard = (run: () => boolean) => () => (this.editor.view.composing ? false : run());
    return {
      Enter: guard(() => {
        if (this.options.getEnterToSend()) {
          this.options.onSubmit();
          return true;
        }
        return newline(this.editor, true);
      }),
      "Shift-Enter": guard(() => newline(this.editor, false)),
      "Mod-Enter": guard(() => {
        this.options.onSubmit();
        return true;
      }),
      Tab: guard(() => indentLine(this.editor, false)),
      "Shift-Tab": guard(() => indentLine(this.editor, true)),
      Escape: guard(() => this.options.onEscape?.() ?? false),
    };
  },
});

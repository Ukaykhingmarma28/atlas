import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { EditorThemeColors } from "./types";
import { getActiveTheme } from "@/features/theme/apply-theme";
import type { ResolvedTheme } from "@/features/theme/resolve-theme";

/**
 * The editor's type metrics. `13px` is the `--text-base` step of the Atlas
 * scale and matches the other CodeMirror surface in the app (the chat
 * composer); the editor used to sit a step above at `14px`, which read as
 * oversized next to every panel around it. `20px` of leading (~1.54) is the
 * comfortable end of the range for code — the previous `18px` (~1.29) packed
 * lines tightly enough to work against legibility rather than for it.
 *
 * Both live on the editor root, NOT on `.cm-content`: CodeMirror measures line
 * height off the content element to position gutter markers, so metrics
 * applied to content alone desync the line numbers from their lines. The
 * stylesheet fallback in `styles/globals.css` (`.cm-editor`) mirrors these two
 * values for the case where the runtime theme injection loses its race.
 */
const EDITOR_FONT_SIZE = "13px";
const EDITOR_LINE_HEIGHT = "20px";
// The fold-gutter label sits a step down from the editor body — text-sm (12px)
// is the exact step the previous literal `12px` already rendered at.
const FOLD_GUTTER_FONT_SIZE = "var(--text-sm)";

/**
 * Build the CodeMirror chrome theme from a color theme. Mirrors the structure of
 * the original hand-rolled `atlasTheme` so behaviour is identical — only the
 * syntax values are theme-driven; the background is always the interface base
 * surface (see `resolveEditorColors`).
 */
export function editorColorsFromTheme(theme: ResolvedTheme | null): EditorThemeColors {
  const key = (name: keyof ResolvedTheme["keys"], fallback: string) =>
    theme?.keys[name] ?? fallback;
  const token = (name: string, fallback: string) => theme?.base[name] ?? fallback;
  return {
    bg: key("editor.background", "#000000"),
    fg: key("editor.foreground", "#d4d4d4"),
    caret: key("editor.caret", "#d4d4d4"),
    gutterBg: key("editor.gutter.background", "#000000"),
    gutterFg: key("editor.gutter.foreground", "#666666"),
    activeLineGutterFg: key("editor.active_line.gutter_foreground", "#d4d4d4"),
    activeLineBg: key("editor.active_line.background", "#ffffff0a"),
    selectionBg: key("editor.selection.background", "#303030"),
    matchBracketBg: key("editor.match_bracket.background", "#2d2d2d"),
    matchBracketOutline: key("editor.match_bracket.border", "#3d3d3d"),
    // The fold placeholder is a secondary surface with a secondary label; it
    // does not need three theme keys of its own.
    foldBg: token("secondary", "#0f0f0f"),
    foldBorder: token("border", "#1e1e1e"),
    foldFg: token("secondary-foreground", "#aaaaaa"),
    comment: key("syntax.comment", "#8f8f8f"),
    keyword: key("syntax.keyword", "#c9a2f5"),
    string: key("syntax.string", "#9ecf8a"),
    number: key("syntax.number", "#e0b070"),
    type: key("syntax.type", "#7fd1e8"),
    func: key("syntax.function", "#ffff00"),
    variable: key("syntax.variable", "#eaeaea"),
    operator: key("syntax.operator", "#9a9a9a"),
    tagName: key("syntax.tag", "#7fd1e8"),
    attributeName: key("syntax.attribute", "#d9b47a"),
    constant: key("syntax.constant", "#e0b070"),
    regexp: key("syntax.regexp", "#e59a72"),
    escape: key("syntax.escape", "#e59a72"),
    definition: key("syntax.definition", "#ffffff"),
    propertyName: key("syntax.property", "#c8c8c8"),
    // Booleans and nulls ARE constants; three keys for one role is two too
    // many, and every built-in theme set all three to the same colour.
    bool: key("syntax.constant", "#e0b070"),
    null: key("syntax.constant", "#e0b070"),
    addLineBg: key("diff.added.background", "#0d2211"),
    removeLineBg: key("diff.removed.background", "#220d0d"),
    contextBg: key("diff.context.background", "#0a0a0a"),
    // Side-by-side reads the same fill as inline: they are the same diff.
    addSideBg: key("diff.added.background", "#0d2211"),
    removeSideBg: key("diff.removed.background", "#220d0d"),
    emphAddBg: key("diff.added.emphasis", "rgba(52,211,153,0.34)"),
    emphRemoveBg: key("diff.removed.emphasis", "rgba(244,63,63,0.34)"),
  };
}

export function buildEditorChromeTheme(theme: ResolvedTheme | null): Extension {
  const c = editorColorsFromTheme(theme);
  return EditorView.theme(
    {
      "&": {
        backgroundColor: c.bg,
        color: c.fg,
        height: "100%",
        fontFamily: "JetBrains Mono, SF Mono, Fira Code, monospace",
        fontSize: EDITOR_FONT_SIZE,
        lineHeight: EDITOR_LINE_HEIGHT,
      },
      ".cm-content": {
        caretColor: c.caret,
        padding: "4px 0",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: c.caret,
        borderLeftWidth: "2px",
      },
      ".cm-gutters": {
        backgroundColor: c.gutterBg,
        color: c.gutterFg,
        border: "none",
        minWidth: "40px",
      },
      ".cm-activeLineGutter": {
        color: c.activeLineGutterFg,
        backgroundColor: "transparent",
      },
      ".cm-activeLine": {
        backgroundColor: c.activeLineBg,
      },
      ".cm-selectionBackground, ::selection": {
        backgroundColor: `${c.selectionBg} !important`,
      },
      ".cm-focused .cm-selectionBackground": {
        backgroundColor: `${c.selectionBg} !important`,
      },
      ".cm-matchingBracket": {
        backgroundColor: c.matchBracketBg,
        outline: `1px solid ${c.matchBracketOutline}`,
      },
      ".cm-foldGutter .cm-gutterElement": {
        color: c.foldFg,
        fontSize: FOLD_GUTTER_FONT_SIZE,
      },
      ".cm-foldPlaceholder": {
        backgroundColor: c.foldBg,
        border: `1px solid ${c.foldBorder}`,
        color: c.foldFg,
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-scroller": {
        overflow: "auto",
        scrollbarWidth: "none",
        "&::-webkit-scrollbar": { display: "none" },
      },
      ".cm-line": {
        padding: "0 4px",
      },
    },
    { dark: theme?.appearance !== "light" },
  );
}

/**
 * Build the syntax HighlightStyle from a color theme.
 *
 * A `HighlightStyle` only colors the tags it names — anything a grammar emits
 * that isn't listed here renders in the plain foreground color. That is why the
 * prose block below matters: Markdown parses fine, but with only the code tags
 * mapped, a `.md` file came out as flat grey text, indistinguishable from
 * having no grammar at all (issue #75).
 *
 * Child tags inherit their parent's rule (`tags.controlKeyword` is a
 * `tags.keyword`), so the code list stays short while still covering the
 * keyword/operator variants the individual grammars reach for.
 * `build-cm-theme.test.ts` pins the set that must resolve to a style.
 */
export function buildHighlightStyle(theme: ResolvedTheme | null): HighlightStyle {
  const c = editorColorsFromTheme(theme);
  return HighlightStyle.define([
    // — Code —
    { tag: tags.comment, color: c.comment, fontStyle: "italic" },
    { tag: tags.keyword, color: c.keyword, fontStyle: "italic" },
    { tag: [tags.string, tags.special(tags.string)], color: c.string },
    { tag: tags.number, color: c.number },
    { tag: [tags.typeName, tags.className, tags.namespace], color: c.type },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: c.func },
    { tag: tags.variableName, color: c.variable },
    { tag: tags.operator, color: c.operator },
    { tag: tags.punctuation, color: c.operator },
    { tag: tags.tagName, color: c.tagName },
    { tag: tags.attributeName, color: c.attributeName },
    {
      tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)],
      color: c.constant,
    },
    { tag: tags.regexp, color: c.regexp },
    { tag: tags.escape, color: c.escape },
    { tag: [tags.definition(tags.variableName), tags.labelName], color: c.definition },
    { tag: tags.propertyName, color: c.propertyName },
    { tag: tags.bool, color: c.bool },
    { tag: tags.null, color: c.null },
    // `atom` is what several grammars use where others use bool/null.
    { tag: tags.atom, color: c.constant },
    // Shebangs, pragmas, front-matter fences. Uses `attributeName` because
    // that is what `--cm-meta` already resolves to for the diff viewer's
    // `.hljs-meta` (see apply-editor-theme.ts) — one concept, one color across
    // both code surfaces.
    { tag: tags.meta, color: c.attributeName },

    // — Prose (Markdown) —
    // Headings carry the accent because they are the document's structure, the
    // way function names are a source file's.
    { tag: tags.heading, color: c.func, fontWeight: "600" },
    { tag: tags.strong, color: c.definition, fontWeight: "600" },
    { tag: tags.emphasis, color: c.definition, fontStyle: "italic" },
    { tag: tags.strikethrough, color: c.comment, textDecoration: "line-through" },
    { tag: [tags.link, tags.url], color: c.type, textDecoration: "underline" },
    { tag: tags.monospace, color: c.string },
    { tag: tags.quote, color: c.comment, fontStyle: "italic" },
    { tag: tags.list, color: c.operator },
    // The `#`, `**` and `-` markers themselves: legible but receding, so the
    // text they mark up stays the thing being read.
    { tag: [tags.processingInstruction, tags.contentSeparator], color: c.comment },
  ]);
}

/**
 * The complete extension bundle for one editor theme: the chrome (colors, type
 * metrics) plus the syntax highlighter.
 *
 * CodeMirror needs BOTH halves — a language extension parses the document, and
 * a `syntaxHighlighting` style colors what it parsed. Keeping them in one
 * function is what stops a caller from installing the theme and quietly
 * omitting the highlighter, which looks exactly like a missing grammar.
 *
 * Everything here is state-free, so the editor can hold it in a `Compartment`
 * and reconfigure on a theme change without touching the document or its undo
 * history.
 */
export function editorThemeExtensions(theme: ResolvedTheme | null = getActiveTheme()): Extension {
  return [buildEditorChromeTheme(theme), syntaxHighlighting(buildHighlightStyle(theme))];
}

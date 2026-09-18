import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ThemePreview } from "../preview-theme";

/**
 * One theme, drawn without being applied.
 *
 * `preview.vars` goes on this element and nothing else: CSS custom properties
 * inherit, so every `var(--…)` below — and every Tailwind utility, since the
 * `@theme` namespace points `--color-*` at those same properties — resolves
 * against the previewed theme while the rest of the app stays on the active
 * one. See `preview-theme.ts` for why that is safe and what it costs.
 *
 * ## What it shows, and why
 *
 * A theme no longer decides syntax alone (which is all the pre-merge
 * `CodeEditorThemeThumbnail` could show, every editor theme having shared one
 * app background). It decides the whole app, so the miniature is a whole
 * window in four bands, each carrying roles nothing else here would reveal:
 *
 *  - **a chrome bar** — the `sidebar` surface, a `border.subtle` hairline,
 *    muted text against the brand fill, and the three `status.*` foregrounds
 *    as window dots. This is the band that separates two themes with the same
 *    syntax palette and different chrome, which the old thumbnail could not.
 *  - **a file rail** — `element.selected` under one row against two
 *    unselected, i.e. the selection contrast the whole app is read through.
 *  - **five editor lines** — the real `syntax.*` keys, on `editor.background`
 *    with its own gutter, an active line and a caret, then a `diff.added` /
 *    `diff.removed` pair. A diff is a surface Atlas paints constantly and no
 *    editor-theme thumbnail ever did.
 *  - **a terminal row** — `terminal.background`/`foreground`, four
 *    `terminal.ansi.*` colours and the cursor. Themes differ most here,
 *    because ANSI is the part authors most often leave to the palette.
 *
 * Everything is fixed text: no randomness, no real data, identical for every
 * theme so two cards differ only in colour.
 */

/**
 * The syntax roles the sample uses, each written out in full.
 *
 * Spelled rather than interpolated from the role name: `resolve-theme.test.ts`
 * greps `src/` for every `var(--…)` and fails on one the registry does not
 * produce. A name built by interpolating the role would hide all seven from
 * it — and did, until the suite caught the half-name it left behind.
 */
const SYNTAX = {
  comment: "var(--atlas-syntax-comment)",
  keyword: "var(--atlas-syntax-keyword)",
  string: "var(--atlas-syntax-string)",
  number: "var(--atlas-syntax-number)",
  function: "var(--atlas-syntax-function)",
  variable: "var(--atlas-syntax-variable)",
  operator: "var(--atlas-syntax-operator)",
} as const;

function Tok({ role, children }: { role: keyof typeof SYNTAX; children: ReactNode }) {
  return <span style={{ color: SYNTAX[role] }}>{children}</span>;
}

/**
 * One rail row: a bar whose colour is the weight of that row's text.
 *
 * The selected row carries `element.selected` AND the accent edge, because
 * `element.selected` is a 6%-alpha overlay by derivation — honest, but at this
 * size an overlay alone is a row you have to look for. The accent edge is the
 * same one the real nav rail draws (`border-l-primary`).
 */
function RailRow({ width, selected }: { width: string; selected?: boolean }) {
  return (
    <div
      className={cn(
        "flex h-2 items-center gap-0.5 rounded-sm pr-0.5",
        selected ? "bg-element-selected" : "pl-0.5",
      )}
    >
      {selected && <div className="h-full w-0.5 shrink-0 rounded-full bg-primary" />}
      <div
        className={cn("h-0.5 rounded-full", width, selected ? "bg-foreground" : "bg-disabled")}
      />
    </div>
  );
}

/** One editor row. `tint` paints the row — an active line, or a diff hunk. */
function Line({ tint, children }: { tint?: string; children: ReactNode }) {
  return (
    <div className="h-3 truncate px-1" style={tint ? { backgroundColor: tint } : undefined}>
      {children}
    </div>
  );
}

export function ThemeMiniature({
  preview,
  className,
}: {
  preview: ThemePreview;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      style={preview.vars}
      className={cn("flex h-28 w-full flex-col overflow-hidden bg-background", className)}
    >
      {/* Chrome. */}
      <div className="flex h-5 shrink-0 items-center gap-1 border-b border-border-subtle bg-sidebar px-1.5">
        <span className="size-1.5 shrink-0 rounded-full bg-error" />
        <span className="size-1.5 shrink-0 rounded-full bg-warning" />
        <span className="size-1.5 shrink-0 rounded-full bg-success" />
        <span className="ml-1 truncate text-3xs text-muted-foreground">atlas</span>
        <span className="ml-auto shrink-0 rounded-sm bg-primary px-1 text-3xs font-medium text-primary-foreground">
          Run
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* File rail. */}
        <div className="flex w-8 shrink-0 flex-col gap-1 border-r border-border-subtle bg-sidebar p-1">
          <RailRow width="w-4" selected />
          <RailRow width="w-3" />
          <RailRow width="w-3.5" />
        </div>

        {/* Editor. */}
        <div
          className="flex min-w-0 flex-1 py-1 font-mono text-3xs"
          style={{ backgroundColor: "var(--atlas-editor-background)" }}
        >
          <div
            className="flex w-3.5 shrink-0 flex-col items-end pr-1"
            style={{
              backgroundColor: "var(--atlas-editor-gutter-background)",
              color: "var(--atlas-editor-gutter-foreground)",
            }}
          >
            <div className="h-3">1</div>
            <div className="h-3">2</div>
            <div
              className="h-3"
              style={{ color: "var(--atlas-editor-active-line-gutter-foreground)" }}
            >
              3
            </div>
            <div className="h-3">4</div>
            <div className="h-3">5</div>
          </div>

          <div className="min-w-0 flex-1" style={{ color: "var(--atlas-editor-foreground)" }}>
            <Line>
              <Tok role="comment">// atlas</Tok>
            </Line>
            <Line>
              <Tok role="keyword">import</Tok> <Tok role="operator">{"{"}</Tok>{" "}
              <Tok role="variable">theme</Tok> <Tok role="operator">{"}"}</Tok>{" "}
              <Tok role="keyword">from</Tok> <Tok role="string">"./atlas"</Tok>
              <Tok role="operator">;</Tok>
            </Line>
            <Line tint="var(--atlas-editor-active-line-background)">
              <Tok role="keyword">export</Tok> <Tok role="keyword">function</Tok>{" "}
              <Tok role="function">paint</Tok>
              <Tok role="operator">(</Tok>
              <Tok role="variable">n</Tok> <Tok role="operator">=</Tok> <Tok role="number">42</Tok>
              <Tok role="operator">{") {"}</Tok>
              <span
                className="ml-px inline-block h-2.5 w-px align-middle"
                style={{ backgroundColor: "var(--atlas-editor-caret)" }}
              />
            </Line>
            <Line tint="var(--atlas-diff-added-background)">
              <span style={{ color: "var(--atlas-diff-added-text)" }}>+ return theme.name;</span>
            </Line>
            <Line tint="var(--atlas-diff-removed-background)">
              <span style={{ color: "var(--atlas-diff-removed-text)" }}>- return null;</span>
            </Line>
          </div>
        </div>
      </div>

      {/* Terminal. */}
      <div
        className="flex h-5 shrink-0 items-center gap-1 border-t border-border-subtle px-1.5 font-mono text-3xs"
        style={{
          backgroundColor: "var(--atlas-terminal-background)",
          color: "var(--atlas-terminal-foreground)",
        }}
      >
        <span className="shrink-0" style={{ color: "var(--atlas-terminal-ansi-blue)" }}>
          ~/atlas
        </span>
        <span className="shrink-0" style={{ color: "var(--atlas-terminal-ansi-green)" }}>
          ❯
        </span>
        <span className="shrink-0">bun test</span>
        <span className="truncate" style={{ color: "var(--atlas-terminal-ansi-cyan)" }}>
          --watch
        </span>
        <span
          className="inline-block h-2.5 w-1 shrink-0"
          style={{ backgroundColor: "var(--atlas-terminal-cursor)" }}
        />
        <span className="ml-auto shrink-0" style={{ color: "var(--atlas-terminal-ansi-yellow)" }}>
          2 warn
        </span>
      </div>
    </div>
  );
}

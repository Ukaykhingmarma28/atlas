# Theme keys

Schema-1 themes have required shadcn **base tokens**, optional eight-colour
**palette** entries, and optional Atlas **theme keys**. A theme key always
resolves in this order: explicit `keys` value, palette source, base-token
source, then the Atlas default for the active appearance. The exact defaults
and transforms (alpha, lightening, or mixing) are the checked registry in
`src/features/theme/theme-key-registry.ts`; no other resolver exists.

An explicit key is written as a dotted TOML key (or as nested tables). A key
may not also be a prefix, so use `terminal.ansi.red`, never both `terminal`
and `terminal.ansi.red`. A key's value is a colour, either bare
(`syntax.keyword = "#c678dd"`) or as a one-field table
(`syntax.keyword = { color = "#c678dd" }`). There are **135** keys in all.

A theme key carries no font style. `font_style` was accepted by the schema
and read by nothing, so `font_style = "italic"` loaded cleanly and rendered
upright; the loader now rejects it by name. Nothing between a resolved key
and CodeMirror, highlight.js or the markdown renderer can carry one, and a
field that only sometimes works is worse than one that does not exist.

## Consuming a key

Most code never touches this file: the applier writes every resolved key to
`:root` as `--atlas-<key with dots and underscores as dashes>`, so a Tailwind
utility or a `var()` follows the theme with no work and recolours on a switch
with no re-render. Prefer that.

Four subsystems cannot, because they take a colour as a JavaScript VALUE rather
than as a style — xterm's `ITheme`, pixi's `Graphics.fill({ color })`, every
recharts colour prop, and mermaid's `themeVariables`. They read
`src/features/theme/theme-values.ts`:

| | |
|---|---|
| `themeColor(key)` | the resolved colour for a theme key |
| `themeBase(token)` | the resolved colour for a base token (`chart-1`, `card`, …) |
| `themeHex(key)` / `hexOf(value)` | the same as pixi's 24-bit integer |
| `onThemeApplied(fn)` | imperative repaint hook — a live xterm, a running pixi scene |
| `useThemeVersion()` | React re-render hook — recharts, mermaid |

Reading the right value once is only half of it. A subsystem that caches a
colour at construction time is still theme-blind; it just fails one switch
later. Every non-CSS consumer subscribes to one of the last two.

## Full key list and derivation sources

The notation below records the first non-explicit source. `P:x` means
`palette.x`; `B:x` means `base.x`; `D` means the appearance-specific Atlas
default. Where a source is colour-transformed, the registry applies that
transform after choosing the source.

| Keys | Rule after an explicit value |
|---|---|
| `border.default` | B:border → D |
| `border.subtle`, `border.variant` | B:sidebar-border → D |
| `border.strong`, `border.focus` | B:ring → D |
| `element.hover`, `element.selected`, `element.active`, `element.highlight`; `ghost_element.hover`, `ghost_element.selected`, `ghost_element.active` | B:foreground → D (alpha overlay) |
| `element.primary_hover`, `element.primary_muted` | B:primary → D (lighten/alpha) |
| `text.muted`, `text.placeholder`, `text.disabled` | B:muted-foreground → D (placeholder/disabled mix toward background) |
| `text.accent` | P:yellow → B:primary → D |
| `status.success.foreground`, `status.success.background` | P:green → D (background alpha) |
| `status.warning.foreground`, `status.warning.background` | P:yellow → D (background alpha) |
| `status.error.foreground`, `status.error.background` | P:red → B:destructive → D (background alpha) |
| `status.info.foreground`, `status.info.background` | P:blue → D (background alpha) |
| `status.purple.foreground` | P:purple → D |
| `status.orange.foreground` | P:orange → D |
| `selection.background`, `terminal.selection`, `editor.selection.background` | B:primary → D (alpha) |
| `terminal.foreground`, `terminal.cursor` | B:foreground → D |
| `terminal.background` | B:background → D |
| `terminal.ansi.black` | B:background → D (lighten) |
| `terminal.ansi.red`, `terminal.ansi.bright_red` | P:red → D (bright lightens) |
| `terminal.ansi.green`, `terminal.ansi.bright_green` | P:green → D (bright lightens) |
| `terminal.ansi.yellow`, `terminal.ansi.bright_yellow` | P:yellow → D (bright lightens) |
| `terminal.ansi.blue`, `terminal.ansi.bright_blue` | P:blue → D (bright lightens) |
| `terminal.ansi.magenta`, `terminal.ansi.bright_magenta` | P:purple → D (bright lightens) |
| `terminal.ansi.cyan`, `terminal.ansi.bright_cyan` | P:cyan → D (bright lightens) |
| `terminal.ansi.white`, `terminal.ansi.bright_white` | B:foreground → D (bright lightens) |
| `terminal.ansi.bright_black` | B:muted-foreground → D |
| `syntax.comment`, `syntax.punctuation` | B:muted-foreground → D |
| `syntax.keyword` | P:purple → D |
| `syntax.string` | P:green → D |
| `syntax.number`, `syntax.constant`, `syntax.boolean`, `syntax.null` | P:orange → D |
| `syntax.type`, `syntax.operator`, `syntax.property` | P:cyan → D |
| `syntax.function` | P:blue → B:primary → D |
| `syntax.variable`, `syntax.definition` | B:foreground → D |
| `syntax.tag`, `syntax.regexp`, `syntax.builtin` | P:red → D |
| `syntax.attribute`, `syntax.meta` | P:yellow → D |
| `syntax.escape` | P:pink → D |
| `editor.background`, `editor.gutter.background` | B:background → D |
| `editor.foreground`, `editor.caret`, `editor.active_line.gutter_foreground` | B:foreground → D |
| `editor.gutter.foreground`, `editor.fold.foreground` | B:muted-foreground → D |
| `editor.active_line.background` | B:foreground → D (alpha) |
| `editor.match_bracket.background` | B:accent → D |
| `editor.match_bracket.border` | B:ring → D |
| `editor.fold.background` | B:secondary → D |
| `editor.fold.border` | B:border → D |
| `scrollbar.track.background` | B:background → D |
| `scrollbar.thumb.background`, `scrollbar.thumb.hover` | B:foreground → D (alpha 0.16 / 0.26) |
| `tab.active.background` | B:accent → D |
| `tab.inactive.background` | B:sidebar → D |
| `tab.active.border` | B:primary → D |
| `panel.rail.background`, `panel.background` | B:sidebar → D |
| `panel.elevated.background` | B:card → D |
| `panel.overlay.background` | B:popover → D |
| `panel.input.background`, `diff.context.background` | B:background → D |
| `diff.added.background`, `diff.added.text`, `diff.add_line.background`, `diff.add_side.background`, `diff.emphasis_added.background` | P:green → D (background roles use alpha) |
| `diff.removed.background`, `diff.removed.text`, `diff.remove_line.background`, `diff.remove_side.background`, `diff.emphasis_removed.background` | P:red → D (background roles use alpha) |
| `diff.modified.background` | P:blue → D (alpha) |
| `comms.outer.background` | B:sidebar → D |
| `comms.surface.background` | B:background → D |
| `comms.mention.background`, `comms.mention.foreground`, `comms.other_mention.background` | B:foreground → D (mention backgrounds use alpha) |
| `comms.other_mention.foreground` | B:muted-foreground → D |
| `comms.unread.foreground`, `comms.unread_strong.foreground` | P:green → D (`unread_strong` mixes toward the background) |
| `agent.claude.foreground`, `agent.claude.background` | P:orange → D (background alpha) |
| `agent.gpt.foreground`, `agent.gpt.background`, `agent.codex.foreground`, `agent.codex.background` | P:green → D (background alpha) |
| `agent.gemini.foreground`, `agent.gemini.background` | P:blue → D (background alpha) |
| `agent.local.foreground`, `agent.local.background` | P:purple → D (background alpha) |
| `agent.cursor.foreground`, `agent.cursor.background`, `agent.kilo.foreground`, `agent.kilo.background` | P:yellow → D (background alpha) |
| `agent.amp.foreground`, `agent.amp.background` | P:pink → D (background alpha) |
| `agent.opencode.foreground`, `agent.opencode.background` | B:muted-foreground → D (background alpha) |
| `stat.added`, `capture.live` | P:green → D |
| `stat.removed` | P:red → D |
| `atlas.ants` | B:primary → D |

## Legacy CSS-variable map

The old names remain aliases through PR 4. This table is exhaustive for the
former `tokens.css` colour variables; names within a cell each map to the
single token or key in the next cell.

| Former variable(s) | Source now |
|---|---|
| `--bg-base`, `--bg-surface`, `--bg-primary` | base `background` |
| `--bg-sidebar` | base `sidebar` |
| `--bg-raised`, `--bg-secondary`, `--bg-elevated` | base `card` |
| `--bg-overlay`, `--bg-tertiary` | base `popover` |
| `--bg-input`, `--bg-canvas`, `--bg-rail`, `--panel-rail-bg`, `--panel-bg`, `--panel-bg-2` | corresponding `panel.*.background` key |
| `--bg-tab-active`, `--bg-tab-inactive` | `tab.*.background` key |
| `--bg-hover`, `--bg-selected`, `--bg-active`, `--selection-bg`, `--bg-elevated-2` | corresponding `element.*`, `selection.background`, or `panel.elevated.background` key |
| `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-inverse` | base `foreground`, `secondary-foreground`, `muted-foreground`, `primary-foreground` |
| `--text-ghost`, `--text-muted`, `--text-accent` | `text.disabled`, `text.muted`, `text.accent` |
| `--border-default`, `--border-subtle`, `--border-strong`, `--border-focus`, `--border-variant` | corresponding `border.*` key |
| `--accent-primary`, `--accent-primary-hover`, `--accent-primary-muted`, `--accent-secondary` | base `primary`, `element.primary_hover`, `element.primary_muted`, base `muted-foreground` |
| `--status-*`, `--danger`, `--warning` | corresponding `status.*` key or base `destructive` |
| `--stat-added`, `--stat-removed`, `--capture-live`, `--atlas-ants-color` | `stat.added`, `stat.removed`, `capture.live`, `atlas.ants` |
| `--diff-*` | corresponding `diff.*` key |
| `--cm-bg`, `--cm-fg`, `--cm-caret`, `--cm-gutter-*`, `--cm-active-*`, `--cm-selection-*`, `--cm-bracket-*`, `--cm-fold-*` | corresponding `editor.*` key |
| `--cm-comment`, `--cm-keyword`, `--cm-string`, `--cm-number`, `--cm-type`, `--cm-func`, `--cm-variable`, `--cm-tag`, `--cm-attr`, `--cm-constant`, `--cm-regexp`, `--cm-property`, `--cm-meta` | corresponding `syntax.*` key |
| `--comms-*` | corresponding `comms.*` key |
| `--agent-*-chip`, `--agent-*-chip-bg` | corresponding `agent.*.foreground` or `agent.*.background` key |

`--font-size-*`, `--space-*`, radius, shadow, z-index and motion variables
are not theme keys. Their current rendered values are deliberately preserved
in Theme Core; changing those scales belongs to Foundations.

## Regenerating checked assets

The JSON Schema and browser mock snapshot are checked by `atlas-theme` tests.
After intentionally changing their Rust shape, regenerate them with:

```bash
cargo run -p atlas-theme --example generate_schema > crates/atlas-theme/schema/theme-v1.json
cargo run -p atlas-theme --example generate_builtins > src/dev/mock-backend/fixtures/builtin-themes.json
```

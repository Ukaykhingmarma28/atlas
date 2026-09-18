# Theme keys

Schema-1 themes have required shadcn **base tokens**, optional eight-colour
**palette** entries, and optional Atlas **theme keys**. A theme key always
resolves in this order: explicit `keys` value, palette source, base-token
source, then the Atlas default for the active appearance.

Every key, its description, its sources and its transform are declared once, in
**`crates/atlas-theme/keys.toml`**. The TS registry the resolver reads, the key
list Rust reads, the `keys` property of the JSON Schema, and the key table below
are all generated from it by `bun run theme:keys`, and `bun run test` fails if
any of them is stale. Editing a key means editing that file; `resolve-theme.ts`
is the only place the derivation order itself lives.

An explicit key is written as a dotted TOML key (or as nested tables). A key
may not also be a prefix, so use `terminal.ansi.red`, never both `terminal`
and `terminal.ansi.red`. The schema enumerates the dotted form, which is what
an editor completes and typo-checks; the nested form still loads. A key's
value is a colour, either bare (`syntax.keyword = "#c678dd"`) or as a
one-field table (`syntax.keyword = { color = "#c678dd" }`).

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

<!-- generated:theme-keys -->
<!-- Generated from crates/atlas-theme/keys.toml by `bun run theme:keys`. Edit that file, not this block. -->

## Full key list and derivation sources

All **131** keys, in the order and grouping of `crates/atlas-theme/keys.toml`.
**Source** is the first thing Atlas tries after an explicit `keys` value:
`P:x` is `palette.x`, `B:x` is `base.x`, and `D` is the Atlas default for the
active appearance, shown here as dark / light. **Transform** is applied to
whichever of those three supplied the colour, and never to an explicit value.

### Borders

Separators and control outlines.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `border.default` | B:border → D | — | `#1e1e1e` / `#d8d3cc` | Default separator and control border. |
| `border.subtle` | B:sidebar-border → D | — | `#141414` / `#ebe5de` | Low-emphasis separator. |
| `border.strong` | B:ring → D | — | `#3d3d3d` / `#b8b1aa` | High-emphasis border. |
| `border.focus` | B:ring → D | — | `#3d3d3d` / `#907aa9` | Focused-control border. |
| `border.variant` | B:sidebar-border → D | — | `#141414` / `#ebe5de` | Alternate low-emphasis border. |

### Elements and overlays

Hover/selected/pressed overlays, and the raised-surface edge.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `element.hover` | B:foreground → D | alpha 0.04 | `rgba(255,255,255,0.04)` / `rgba(0,0,0,0.04)` | Hover overlay for ordinary elements. |
| `element.selected` | B:foreground → D | alpha 0.06 | `rgba(255,255,255,0.06)` / `rgba(0,0,0,0.06)` | Selected overlay for ordinary elements. |
| `element.active` | B:foreground → D | alpha 0.08 | `rgba(255,255,255,0.08)` / `rgba(0,0,0,0.08)` | Pressed overlay for ordinary elements. |
| `element.highlight` | B:foreground → D | alpha 0.06 | `rgba(255,255,255,0.06)` / `rgba(0,0,0,0.06)` | Top-edge highlight on a raised surface. |
| `element.primary_hover` | B:primary → D | lighten 0.15 | `#cccccc` / `#a290b5` | Hovered primary-brand fill. |
| `element.primary_muted` | B:primary → D | alpha 0.06 | `rgba(255,255,255,0.06)` / `rgba(144,122,169,0.08)` | Muted primary-brand fill. |
| `ghost_element.hover` | B:foreground → D | alpha 0.03 | `rgba(255,255,255,0.03)` / `rgba(0,0,0,0.03)` | Hover overlay for ghost controls. |
| `ghost_element.selected` | B:foreground → D | alpha 0.05 | `rgba(255,255,255,0.05)` / `rgba(0,0,0,0.05)` | Selected overlay for ghost controls. |
| `ghost_element.active` | B:foreground → D | alpha 0.07 | `rgba(255,255,255,0.07)` / `rgba(0,0,0,0.07)` | Pressed overlay for ghost controls. |

### Text

Prose roles that are not a base token.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `text.muted` | B:muted-foreground → D | — | `#585858` / `#797593` | Muted prose and metadata. |
| `text.placeholder` | B:muted-foreground → D | mix 0.12 → B:background | `#777777` / `#9893a5` | Input placeholder text. |
| `text.disabled` | B:muted-foreground → D | mix 0.35 → B:background | `#333333` / `#b8b1aa` | Disabled and unavailable text. |
| `text.accent` | P:yellow → B:primary → D | — | `#ffff00` / `#907aa9` | Rare text-only signature accent. |

### Status

Success / warning / error / info, plus two categorical hues.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `status.success.foreground` | P:green → D | — | `#4d4d4d` / `#286983` | Success status foreground. |
| `status.warning.foreground` | P:yellow → D | — | `#cd9731` / `#ea9d34` | Warning status foreground. |
| `status.error.foreground` | P:red → B:destructive → D | — | `#f44747` / `#b4637a` | Error status foreground. |
| `status.info.foreground` | P:blue → D | — | `#6796e6` / `#56949f` | Informational status foreground. |
| `status.purple.foreground` | P:purple → D | — | `#999999` / `#907aa9` | Purple categorical status. |
| `status.orange.foreground` | P:orange → D | — | `#cd9731` / `#d7827e` | Orange categorical status. |

### Selection

Document text selection.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `selection.background` | B:primary → D | alpha 0.18 | `rgba(255,255,255,0.18)` / `rgba(144,122,169,0.18)` | Document text selection. |

### Terminal

The PTY surface and the 16 ANSI colours.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `terminal.foreground` | B:foreground → D | — | `#d4d4d4` / `#575279` | Terminal default foreground. |
| `terminal.background` | B:background → D | — | `#000000` / `#faf4ed` | Terminal background. |
| `terminal.cursor` | B:foreground → D | — | `#d4d4d4` / `#575279` | Terminal cursor. |
| `terminal.selection` | B:primary → D | alpha 0.3 | `rgba(255,255,255,0.3)` / `rgba(144,122,169,0.3)` | Terminal selection. |
| `terminal.ansi.black` | B:background → D | lighten 0.12 | `#1e1e1e` / `#575279` | ANSI black. |
| `terminal.ansi.red` | P:red → D | — | `#f44747` / `#b4637a` | ANSI red. |
| `terminal.ansi.green` | P:green → D | — | `#98c379` / `#286983` | ANSI green. |
| `terminal.ansi.yellow` | P:yellow → D | — | `#e5c07b` / `#ea9d34` | ANSI yellow. |
| `terminal.ansi.blue` | P:blue → D | — | `#61afef` / `#56949f` | ANSI blue. |
| `terminal.ansi.magenta` | P:purple → D | — | `#c678dd` / `#907aa9` | ANSI magenta. |
| `terminal.ansi.cyan` | P:cyan → D | — | `#56b6c2` / `#d7827e` | ANSI cyan. |
| `terminal.ansi.white` | B:foreground → D | — | `#d4d4d4` / `#575279` | ANSI white. |
| `terminal.ansi.bright_black` | B:muted-foreground → D | — | `#666666` / `#9893a5` | ANSI bright black. |
| `terminal.ansi.bright_red` | P:red → D | lighten 0.15 | `#ff6b6b` / `#c97991` | ANSI bright red. |
| `terminal.ansi.bright_green` | P:green → D | lighten 0.15 | `#b2d89a` / `#4d8399` | ANSI bright green. |
| `terminal.ansi.bright_yellow` | P:yellow → D | lighten 0.15 | `#f2d28c` / `#edae52` | ANSI bright yellow. |
| `terminal.ansi.bright_blue` | P:blue → D | lighten 0.15 | `#82c0f3` / `#73a5ae` | ANSI bright blue. |
| `terminal.ansi.bright_magenta` | P:purple → D | lighten 0.15 | `#d493e5` / `#a290b5` | ANSI bright magenta. |
| `terminal.ansi.bright_cyan` | P:cyan → D | lighten 0.15 | `#78c7d0` / `#dd9794` | ANSI bright cyan. |
| `terminal.ansi.bright_white` | B:foreground → D | lighten 0.18 | `#ffffff` / `#464261` | ANSI bright white. |

### Syntax

CodeMirror and Markdown highlighting.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `syntax.comment` | B:muted-foreground → D | — | `#8f8f8f` / `#9893a5` | Comments and prose quotes. |
| `syntax.keyword` | P:purple → D | — | `#c9a2f5` / `#286983` | Keywords and control flow. |
| `syntax.string` | P:green → D | — | `#9ecf8a` / `#ea9d34` | Strings. |
| `syntax.number` | P:orange → D | — | `#e0b070` / `#ea9d34` | Numbers. |
| `syntax.type` | P:cyan → D | — | `#7fd1e8` / `#56949f` | Types, classes, and namespaces. |
| `syntax.function` | P:blue → B:primary → D | — | `#ffff00` / `#286983` | Functions and headings. |
| `syntax.variable` | B:foreground → D | — | `#eaeaea` / `#575279` | Variables. |
| `syntax.operator` | P:cyan → D | — | `#9a9a9a` / `#797593` | Operators. |
| `syntax.tag` | P:red → D | — | `#7fd1e8` / `#b4637a` | Markup tags. |
| `syntax.attribute` | P:yellow → D | — | `#d9b47a` / `#907aa9` | Markup attributes. |
| `syntax.constant` | P:orange → D | — | `#e0b070` / `#d7827e` | Constants and atoms. |
| `syntax.regexp` | P:red → D | — | `#e59a72` / `#b4637a` | Regular expressions. |
| `syntax.escape` | P:pink → D | — | `#e59a72` / `#d7827e` | Escape sequences. |
| `syntax.definition` | B:foreground → D | — | `#ffffff` / `#464261` | Definitions and strong prose. |
| `syntax.property` | P:cyan → D | — | `#c8c8c8` / `#56949f` | Properties and object keys. |
| `syntax.boolean` | P:orange → D | — | `#e0b070` / `#d7827e` | Booleans. |
| `syntax.null` | P:orange → D | — | `#e0b070` / `#d7827e` | Null-like literals. |
| `syntax.meta` | P:yellow → D | — | `#d9b47a` / `#907aa9` | Pragmas and metadata. |
| `syntax.builtin` | P:red → D | — | `#e59a72` / `#b4637a` | Built-in symbols. |
| `syntax.punctuation` | B:muted-foreground → D | — | `#9a9a9a` / `#797593` | Punctuation. |

### Editor

The code editor's own chrome.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `editor.background` | B:background → D | — | `#000000` / `#faf4ed` | Code editor background. |
| `editor.foreground` | B:foreground → D | — | `#d4d4d4` / `#575279` | Code editor foreground. |
| `editor.caret` | B:foreground → D | — | `#d4d4d4` / `#575279` | Code editor caret. |
| `editor.gutter.background` | B:background → D | — | `#000000` / `#faf4ed` | Code editor gutter background. |
| `editor.gutter.foreground` | B:muted-foreground → D | — | `#666666` / `#9893a5` | Code editor line numbers. |
| `editor.active_line.background` | B:foreground → D | alpha 0.04 | `rgba(255,255,255,0.04)` / `rgba(0,0,0,0.04)` | Active editor line. |
| `editor.active_line.gutter_foreground` | B:foreground → D | — | `#d4d4d4` / `#575279` | Active line number. |
| `editor.selection.background` | B:primary → D | alpha 0.24 | `#303030` / `#dfdad9` | Editor selection. |
| `editor.match_bracket.background` | B:accent → D | — | `#2d2d2d` / `#dfdad9` | Matching bracket background. |
| `editor.match_bracket.border` | B:ring → D | — | `#3d3d3d` / `#907aa9` | Matching bracket outline. |
| `editor.fold.background` | B:secondary → D | — | `#1a1a1a` / `#f2e9e1` | Fold placeholder background. |
| `editor.fold.border` | B:border → D | — | `#2a2a2a` / `#cecacd` | Fold placeholder border. |
| `editor.fold.foreground` | B:muted-foreground → D | — | `#8a8a8a` / `#797593` | Fold placeholder foreground. |

### Chrome surfaces

Scrollbars, tabs, panels — the app frame.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `scrollbar.track.background` | B:background → D | — | `#000000` / `#faf4ed` | Scrollbar track. |
| `scrollbar.thumb.background` | B:foreground → D | alpha 0.16 | `rgba(255,255,255,0.16)` / `rgba(0,0,0,0.16)` | Scrollbar thumb. |
| `scrollbar.thumb.hover` | B:foreground → D | alpha 0.26 | `rgba(255,255,255,0.26)` / `rgba(0,0,0,0.26)` | Hovered scrollbar thumb. |
| `tab.active.background` | B:accent → D | — | `#171717` / `#f2e9e1` | Active tab background. |
| `tab.inactive.background` | B:sidebar → D | — | `#0a0a0a` / `#fffaf3` | Inactive tab background. |
| `tab.active.border` | B:primary → D | — | `#ffffff` / `#907aa9` | Active tab indicator. |
| `panel.rail.background` | B:sidebar → D | — | `#0f0f0f` / `#fffaf3` | Project rail background. |
| `panel.background` | B:sidebar → D | — | `#060706` / `#fffaf3` | Panel background. |
| `panel.elevated.background` | B:card → D | — | `#0d0e0d` / `#f2e9e1` | Elevated panel background. |
| `panel.overlay.background` | B:popover → D | — | `#1c1c1c` / `#f2e9e1` | Panel overlay background. |
| `panel.input.background` | B:background → D | — | `#0a0a0a` / `#fffaf3` | Panel input background. |

### Diff

Added / removed / modified regions, inline and side-by-side.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `diff.added.background` | P:green → D | alpha 0.08 | `rgba(77,77,77,0.08)` / `rgba(40,105,131,0.08)` | Added diff region. |
| `diff.added.text` | P:green → D | — | `#3fb950` / `#286983` | Added diff text. |
| `diff.removed.background` | P:red → D | alpha 0.08 | `rgba(119,119,119,0.08)` / `rgba(180,99,122,0.08)` | Removed diff region. |
| `diff.removed.text` | P:red → D | — | `#777777` / `#b4637a` | Removed diff text. |
| `diff.modified.background` | P:blue → D | alpha 0.08 | `rgba(192,192,192,0.08)` / `rgba(86,148,159,0.08)` | Modified diff region. |
| `diff.add_line.background` | P:green → D | alpha 0.13 | `#0d2211` / `rgba(40,105,131,0.13)` | Added line background. |
| `diff.remove_line.background` | P:red → D | alpha 0.13 | `#220d0d` / `rgba(180,99,122,0.13)` | Removed line background. |
| `diff.context.background` | B:background → D | — | `#0a0a0a` / `#faf4ed` | Unchanged diff context. |
| `diff.add_side.background` | P:green → D | alpha 0.13 | `rgba(34,197,94,0.13)` / `rgba(40,105,131,0.13)` | Side-by-side addition. |
| `diff.remove_side.background` | P:red → D | alpha 0.13 | `rgba(244,63,63,0.13)` / `rgba(180,99,122,0.13)` | Side-by-side removal. |
| `diff.emphasis_added.background` | P:green → D | alpha 0.34 | `rgba(52,211,153,0.34)` / `rgba(40,105,131,0.34)` | Intraline addition. |
| `diff.emphasis_removed.background` | P:red → D | alpha 0.34 | `rgba(244,63,63,0.34)` / `rgba(180,99,122,0.34)` | Intraline removal. |

### Team chat

The comms panel.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `comms.outer.background` | B:sidebar → D | — | `#0f0f0f` / `#fffaf3` | Team chat outer surface. |
| `comms.surface.background` | B:background → D | — | `#000000` / `#faf4ed` | Team chat transcript surface. |
| `comms.mention.background` | B:foreground → D | alpha 0.16 | `rgba(255,255,255,0.16)` / `rgba(0,0,0,0.1)` | Current-user mention background. |
| `comms.mention.foreground` | B:foreground → D | — | `#ffffff` / `#575279` | Current-user mention text. |
| `comms.other_mention.background` | B:foreground → D | alpha 0.08 | `rgba(255,255,255,0.08)` / `rgba(0,0,0,0.06)` | Other-user mention background. |
| `comms.other_mention.foreground` | B:muted-foreground → D | — | `#cfcfcf` / `#797593` | Other-user mention text. |
| `comms.unread.foreground` | P:green → D | — | `#b8b8b8` / `#286983` | Unread and presence indicator. |
| `comms.unread_strong.foreground` | P:green → D | mix 0.2 → B:background | `#8a8a8a` / `#286983` | Strong unread indicator. |

### Agents and indicators

Per-agent identity chips and small live indicators.

| Key | Source | Transform | D (dark / light) | What it colours |
|---|---|---|---|---|
| `agent.claude.foreground` | P:orange → D | — | `#c98263` / `#b4637a` | Claude identity chip. |
| `agent.claude.background` | P:orange → D | alpha 0.1 | `rgba(201,130,99,0.1)` / `rgba(180,99,122,0.1)` | Claude identity background. |
| `agent.gpt.foreground` | P:green → D | — | `#5fb39a` / `#286983` | GPT identity chip. |
| `agent.gpt.background` | P:green → D | alpha 0.1 | `rgba(95,179,154,0.1)` / `rgba(40,105,131,0.1)` | GPT identity background. |
| `agent.gemini.foreground` | P:blue → D | — | `#7aa7e8` / `#56949f` | Gemini identity chip. |
| `agent.gemini.background` | P:blue → D | alpha 0.1 | `rgba(122,167,232,0.1)` / `rgba(86,148,159,0.1)` | Gemini identity background. |
| `agent.local.foreground` | P:purple → D | — | `#b8a3df` / `#907aa9` | Local-agent identity chip. |
| `agent.local.background` | P:purple → D | alpha 0.1 | `rgba(184,163,223,0.1)` / `rgba(144,122,169,0.1)` | Local-agent identity background. |
| `agent.cursor.foreground` | P:yellow → D | — | `#d9b56e` / `#ea9d34` | Cursor identity chip. |
| `agent.cursor.background` | P:yellow → D | alpha 0.1 | `rgba(217,181,110,0.1)` / `rgba(234,157,52,0.1)` | Cursor identity background. |
| `agent.amp.foreground` | P:pink → D | — | `#d68aae` / `#d7827e` | Amp identity chip. |
| `agent.amp.background` | P:pink → D | alpha 0.1 | `rgba(214,138,174,0.1)` / `rgba(215,130,126,0.1)` | Amp identity background. |
| `agent.codex.foreground` | P:green → D | — | `#10a37f` / `#286983` | Codex identity chip. |
| `agent.codex.background` | P:green → D | alpha 0.1 | `rgba(16,163,127,0.1)` / `rgba(40,105,131,0.1)` | Codex identity background. |
| `agent.opencode.foreground` | B:muted-foreground → D | — | `#9ca3af` / `#797593` | OpenCode identity chip. |
| `agent.opencode.background` | B:muted-foreground → D | alpha 0.1 | `rgba(156,163,175,0.1)` / `rgba(121,117,147,0.1)` | OpenCode identity background. |
| `agent.kilo.foreground` | P:yellow → D | — | `#f0c53d` / `#ea9d34` | Kilo identity chip. |
| `agent.kilo.background` | P:yellow → D | alpha 0.1 | `rgba(240,197,61,0.1)` / `rgba(234,157,52,0.1)` | Kilo identity background. |
| `stat.added` | P:green → D | — | `#3fb950` / `#286983` | Added-line statistic. |
| `stat.removed` | P:red → D | — | `#f85149` / `#b4637a` | Removed-line statistic. |
| `capture.live` | P:green → D | — | `#3fb950` / `#286983` | Active capture indicator. |
| `atlas.ants` | B:primary → D | — | `#ffffff` / `#907aa9` | Animated marching-ants stroke. |

## Derived variables

Atlas writes these **4** `--atlas-…` custom properties too, but
they are **not** theme keys: each is a pure transform of a key that is, so a
theme steers it through that key. Writing one in a theme file is an
unknown-key warning.

| Variable | Derived from | Transform | What it colours |
|---|---|---|---|
| `status.success.background` | `status.success.foreground` | alpha 0.12 | Tinted fill behind a success foreground. |
| `status.warning.background` | `status.warning.foreground` | alpha 0.12 | Tinted fill behind a warning foreground. |
| `status.error.background` | `status.error.foreground` | alpha 0.12 | Tinted fill behind an error foreground. |
| `status.info.background` | `status.info.foreground` | alpha 0.12 | Tinted fill behind an informational foreground. |

<!-- /generated:theme-keys -->

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

After editing `crates/atlas-theme/keys.toml` — adding, removing, renaming a key,
or changing what one derives from:

```bash
bun run theme:keys          # rewrites all four generated files
bun run theme:keys:check    # what `bun run test` runs; fails on anything stale
```

`theme:keys` shells out to the schema example below, so it needs cargo;
`theme:keys:check` does not.

The JSON Schema and browser mock snapshot are also checked by `atlas-theme`
tests. After intentionally changing their Rust shape, regenerate them with:

```bash
cargo run -p atlas-theme --example generate_schema > crates/atlas-theme/schema/theme-v1.json
cargo run -p atlas-theme --example generate_builtins > src/dev/mock-backend/fixtures/builtin-themes.json
```

# ADR-0009: One theme format — shadcn base tokens, optional palette and keys, everything else derived

**Status:** Accepted (2026-09-17). Plan and audit: `docs-atlas/content/private/theme-system.mdx`.

## Context

Atlas had two theme systems: 6 "interface themes" and 10 "editor themes". Both were hardcoded TypeScript and dark-only.

- An interface theme set 33 of the 170 CSS variables in `tokens.css`. Everything else stayed at Atlas Black's values.
- About 686 colour literals bypassed tokens entirely.
- The terminal, the chat code highlighting, the graphs and the charts ignored the theme altogether.

That is why Rosé Pine "didn't apply everywhere": nothing guaranteed that every colour was either set by the theme or computed from it.

## Decision

**One theme covers the whole app.** A **theme** is one TOML file with a `dark` and/or `light` **variant**. It covers chrome, editor, terminal, diffs and syntax; there is no separate editor theme. Each variant has three levels:

1. **Base tokens** (required). These are the shadcn/ui token set, named exactly as shadcn names them, so any shadcn or tweakcn theme is a valid base.
2. **Palette** (optional). Eight named hues: red, orange, yellow, green, cyan, blue, purple, pink.
3. **Theme keys** (optional). Atlas-specific colours, named by role in Zed's dotted style (`element.hover`, `terminal.ansi.red`, `syntax.keyword`).

**Every theme key has a derivation rule.** A missing key is resolved in this order: explicit key → palette-derived → base-derived → Atlas default for that appearance. The resolver runs in TypeScript and emits a fully resolved variable map, which is also used by non-CSS consumers such as xterm, pixi and recharts. A test asserts that every key resolves to a colour for every built-in theme.

**Rust owns theme files.** Rust parses and validates built-in themes and the themes in `~/.config/atlas/themes/`. The frontend receives JSON.

**One key-naming rule.** No key may be both a leaf and a prefix of another key, so the dotted names are valid unquoted TOML (`border.default`, not `border`).

**Import is one-time conversion into this format.** Sources are shadcn/tweakcn, Zed and VS Code; each converted source is never read again.

**File icons are a separate icon theme.** Icon themes use VS Code's `iconThemes` format verbatim, so VS Code icon themes install as-is.

## Considered options

- **Two pickers (interface and editor), as before.** Rejected. Neither VS Code nor Zed does this; both use one theme plus user overrides, and one artefact is simpler for community contributors.
- **shadcn tokens only, deriving everything else.** Rejected. A 31-token palette cannot say what Rosé Pine's syntax or ANSI colours are.
- **An Atlas theme as a shadcn registry item with extras in `meta`.** Rejected. The registry format has no place for per-variant palette or syntax data. Instead we export shadcn registry JSON, which is lossy only for the Atlas extras.
- **JSON theme files.** Rejected in favour of TOML. TOML allows comments, forgives trailing commas, and matches `config.toml`. JSON Schema still drives editor completion via `#:schema`.
- **Derivation in CSS with `color-mix()` and relative colour syntax.** Rejected. Relative colour syntax needs Safari 16.4, but Atlas's minimum is macOS 11. It also cannot feed canvas and WebGL consumers.

## Consequences

- **The token names are a public contract.** Renaming a base token or theme key breaks community themes, so the TOML carries `schema = 1`.
- **`accent` changes meaning.** It now follows shadcn: a hover/selected surface. Atlas's brand colour is `primary`.
- **User settings move.** `atlasTheme` and `codeEditorTheme` in `config.toml` are replaced by `theme`, `themeMode` and `themeOverrides`. Old values are migrated once.

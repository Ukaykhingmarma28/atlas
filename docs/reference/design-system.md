# Design system

The non-colour half of Atlas's design system: the scales, what they are called,
which primitive to reach for, and the test that stops the app drifting back off
them. Colour is the other half and lives in [`theme-keys.md`](./theme-keys.md).

Everything here is defined in two files:

| file | holds |
|---|---|
| `src/styles/tokens.css` | the raw custom properties on `:root` — the shadcn base tokens, control heights, layout constants, radius derivation, elevation, motion durations and z-index layers |
| `src/styles/globals.css` | the Tailwind namespaces (`@theme`), the named utilities (`@utility`), and the global focus rule |

Primitives live in `src/ui/`. The gallery that renders all of it is the dev-only
mock scenario **`localhost:1420/?scenario=design-system`** — open it before and
after any change to this page.

## Naming rules

1. **Use a Tailwind namespace if one exists.** Type is `--text-*`, radius is
   `--radius-*`, elevation is `--shadow-*`, easing is `--ease-*`, blur is
   `--blur-*`, spacing is Tailwind's `--spacing` multiplier. Only z-index,
   control heights and durations are custom, because Tailwind's equivalents take
   bare numbers and cannot be given names.
2. **A scale step is named, never measured.** `text-xs`, not `text-[11px]`;
   `z-popover`, not `z-[9999]`. The number belongs in `tokens.css` exactly once.
3. **A token is a role, not a value.** There are no 12-step colour ramps and no
   per-component colour tokens. A theme key exists only when a theme author
   needs that surface to differ from the base tokens.
4. **One name per colour.** The legacy aliases are gone: `--bg-*`, the colour
   `--text-*`, `--cm-*`, `--shadow-overlay`, `--z-max` and the rest were second
   names for a base token or a theme key, and the sweep spent them. Write the
   shadcn name (`bg-card`, `text-muted-foreground`) or the theme key
   (`bg-element-hover`, `text-disabled`). Do not add a synonym for either.

## Type

Nine steps (decision 24). Half-pixel sizes — the audit found ~130 of them —
round **up** to the next step.

| utility | px | line-height | typical use |
|---|---|---|---|
| `text-3xs` | 9 | 12 | a badge on a dense row |
| `text-2xs` | 10 | 14 | eyebrows, captions, keycaps |
| `text-xs` | 11 | 15 | control text; the most common size in Atlas |
| `text-sm` | 12 | 16 | list rows, secondary chrome |
| `text-base` | 13 | 18 | body text, chat messages |
| `text-md` | 14 | 20 | panel and dialog titles |
| `text-lg` | 16 | 22 | page headings |
| `text-xl` | 20 | 26 | empty-state headlines |
| `text-2xl` | 24 | 30 | the largest thing in the app |

**Two weights only**: `font-medium` (500) and `font-semibold` (600). Nothing
lighter, nothing heavier — the app is a dense monochrome UI and 400 disappears
against it.

### Named text styles

Six `@utility` classes. Reach for one of these *before* reaching for a size plus
a weight plus a colour — that combination is how the 1,335 arbitrary sizes got
there.

| utility | what it is |
|---|---|
| `eyebrow` | the section header above a group of rows — 10px, 600, uppercase, tracked |
| `label` | the text on and beside a control — 11px, 500 |
| `body` | running prose: a description, a message — 13px, 500 |
| `caption` | the dimmed second line under something — 10px, 500, muted |
| `code` | any monospace run: a path, a hash, a command — 12px, 500 |
| `heading` | a panel or dialog title — 14px, 600 |

## Control heights

Four steps (decision 25). The heights the audit found at 22, 28 and 30 snap to
the nearest step.

| utility | px | use |
|---|---|---|
| `h-control-xs` | 20 | inline chip, keycap |
| `h-control-sm` | 24 | dense toolbar control |
| `h-control-md` | 26 | **the default control** |
| `h-control-lg` | 32 | primary action, search field |

`size-control-xs … size-control-lg` give the same value on both axes, for an
icon-only control.

Two named layout constants, which are **not** controls and are not on the scale:
`h-titlebar` (30px) and `h-tab-strip` (36px, the centre tab strip).

## Radius

Derived from the theme's `--radius` (decision 26), so one number in a theme file
moves the whole scale:

```
sm = r − 4    md = r − 2    lg = r    xl = r + 4    full = 9999px
```

| utility | use |
|---|---|
| `rounded` | alias of `rounded-sm` — bare `rounded` is the control radius |
| `rounded-sm` | controls: buttons, inputs, keycaps |
| `rounded-md` | cards and rows |
| `rounded-lg` | popovers and menus |
| `rounded-xl` | dialogs |
| `rounded-full` | pills and avatars |

Rendered today: **4 / 6 / 8 / 12**. Before Foundations it was 2 / 4 / 6 with no
`xl`, and bare `rounded` was 4px. Two things to know:

- **Bare `rounded` changed.** Tailwind's own `rounded` is a static `0.25rem`
  that no theme value can reach, so `globals.css` redeclares it in the utilities
  layer, after the generated rules. It therefore beats `.rounded` and still
  loses to `.rounded-lg` on an element carrying both.
- **The scale reads `--radius-base`, which is now plain `var(--radius)`.** It
  briefly carried a `max(…, 8px)` floor: Atlas sets its root font-size to 13px
  (`globals.css`, `@layer base`), so a `rem` here is 13px, and every built-in
  theme file shipped `radius = "0.375rem"` — 4.875px, with `r − 4px` collapsing
  to 0.875px, i.e. square everywhere whatever the theme asked for. The theme
  files now ship `radius = "8px"`, the floor is gone, and a theme that wants to
  be **squarer** than 8px finally can be. A theme file is the only place the
  scale is set; do not reintroduce a floor.

## Elevation

Three levels (decision 27). The shadow **colour comes from the theme**: each
level points at one of the theme's shadcn `--shadow-*` tokens through an
`--elevation-*` variable in `tokens.css`. A theme's `[light.base]` and
`[dark.base]` tables set their own `--shadow-*` ramps independently — a light
appearance is not the dark ramp reused as-is. Pure black at the dark table's
alphas reads as a heavy halo on a light surface, so a light ramp should tint
from the theme's own light-appearance foreground (or another dark-enough base
colour) at a much lower alpha instead.

| utility | level |
|---|---|
| `shadow-sm` | raised off the surface |
| `shadow-md` | menus and popovers |
| `shadow-lg` | dialogs |

`shadow-xl` and `shadow-2xl` are pointed at the dialog level as well, because
left alone they render Tailwind's 10%-black default, which is invisible on
Atlas's near-black chrome. Do not introduce a fourth level.

Two more utilities belong here:

- `inset-highlight` — the 1px top edge on raised glass. It delegates to
  Tailwind's own inset-shadow utility, so `inset-highlight shadow-md` composes
  instead of one replacing the other. Its colour is the `element.highlight`
  theme key — the theme's foreground at 6% — so a light variant gets a dark
  edge instead of the white-on-white one a hardcoded highlight would give it.
- `backdrop-blur-glass` — the one glass blur (`--blur-glass`, 24px).

One thing to keep in mind:

- **`shadow-md` is pinned to the theme's `--shadow-2xl`**, which is exactly what
  `--shadow-overlay` renders, so the sweep can replace all 83
  `shadow-[var(--shadow-overlay)]` sites with `shadow-md` and move nothing. Do
  not repoint it. `shadow-lg` stacks the theme's `--shadow-xl` under its
  `--shadow-2xl` to get a rung of its own — the shadcn scale has no fourth
  step, and `md` and `lg` resolving to the same value made every dialog read as
  a popover.

## The scrim

Two utilities, and the colour is **deliberately not a theme key**.

| utility | what it is |
|---|---|
| `scrim` | a dialog, a command palette, a lightbox — the app behind is out of reach |
| `scrim-soft` | an in-panel drawer whose own surface carries the depth |

The decision, because it looks like an omission: a scrim's whole job is to push
what is behind it away from the reader, and only *darkening* does that. Over a
light theme a light scrim separates nothing. Every light UI worth copying
darkens — macOS sheets, VS Code light, and shadcn's own `DialogOverlay`, which
is a bare `bg-black/50` in both appearances and is not a token there either.
Making it a key would offer a theme author a choice with one correct answer, and
the wrong answer would silently switch the dim off. Appearance is carried by the
alpha instead: 60% black reads as a heavy dim on cream and as a deepening on
near-black, which is the same instruction in both.

What *was* drift is that 29 sites wrote nine different alphas by hand
(`bg-black/10` through `/80`). Those two utilities are now the whole vocabulary,
and `scrim` is also the right fill for a control that sits over arbitrary media
— a user's photo, a PDF page — for the same reason: nothing about the theme
tells you what is underneath.

**The mirror of this is `bg-white/[0.06]`, and that one is not invariant.** A
white hairline or a white wash is the *dark*-appearance reading of "this surface
catches the light"; on cream it is nothing at all. Those 49 sites moved onto the
element roles — `bg-element-hover` / `-selected` / `-active`,
`border-border-subtle` / `-border` / `-border-strong` — which are the theme's own
foreground at an alpha and therefore flip with the appearance.

Three literals survive on purpose, all of them decision 3's documented
exceptions: the PDF page (paper is white), the lightbox matte behind someone
else's photo, and the Windows close button's system red in the titlebar.

## Z-index

Nine named layers (decision 28). Nothing outside `globals.css` writes a
z-index — not a class, not an inline style.

| utility | value | what sits there |
|---|---|---|
| `z-panel` | 10 | in-panel stacking: sticky headers, resize handles |
| `z-titlebar` | 40 | the titlebar and its dock |
| `z-drawer` | 60 | a panel that slides over the chrome: the project rail, the notification drawer |
| `z-overlay` | 100 | a dialog's scrim |
| `z-modal` | 110 | the dialog itself |
| `z-popover` | 200 | menus, popovers, comboboxes |
| `z-toast` | 300 | toasts |
| `z-tooltip` | 400 | tooltips |
| `z-drag` | 500 | whatever is under the cursor mid-drag |

`popover` sits **above** `modal` deliberately: a menu opened inside a dialog has
to escape it. That is the ordering bug the audit found, where everything shared
9999.

`drawer` was the band nothing named. A drawer has to clear the titlebar and has
to lose to a dialog, so the project rail wrote `z-[55]`/`z-[60]` and the
notification drawer wrote `z-[9998]`/`z-[9999]` — two answers to one question,
and the second one put a dismissible drawer above every modal in the app. **A
drawer's own scrim is an earlier sibling on the same layer**, not a layer of its
own: they share a stacking context, so document order already puts the panel
above its dim, and `overlay`/`modal` stay the dialog's pair.

## Motion

Four durations and exactly three easing curves (decision 29). No new curve gets
added without a decision.

| utility | value | |
|---|---|---|
| `duration-instant` | 80ms | a state flip the user should not perceive as motion |
| `duration-fast` | 120ms | hover and focus transitions |
| `duration-base` | 180ms | the default: menus, popovers, tabs |
| `duration-slow` | 260ms | panels and drawers travelling a long way |

| easing | use |
|---|---|
| `ease-out-strong` | entrances; the default |
| `ease-in-out-strong` | two-way state changes |
| `ease-drawer` | panels and drawers sliding in |

`src/ui/tooltip-timing.ts` is the model for a component that needs more than a
duration — a shared open delay, a warm-start window, reduced-motion handling.
Copy its shape rather than scattering timers.

## Icons

One wrapper: `src/ui/icon.tsx` (decision 30).

```tsx
import { Search } from "lucide-react";
import { Icon } from "@/ui/icon";

<Icon icon={Search} size="sm" />;
```

Five sizes — `xs` 10, `sm` 12, `md` 14 (the default), `lg` 16, `xl` 20 — and one
stroke width, **1.75**. Lucide's own default of 2 reads heavy at these sizes.

The sweep maps the 903 existing `size={n}` call sites onto the scale:

```
9 → 10 (xs)   10 → 10 (xs)   11 → 12 (sm)   12 → 12 (sm)
13 → 14 (md)  14 → 14 (md)   16 → 16 (lg)   20 → 20 (xl)
```

Foundations ships the wrapper and uses it in the `src/ui` primitives only;
migrating the call sites is the sweep's job.

## States

**Focus** (decision 31). There is one keyboard focus indicator: a 2px
`var(--ring)` outline on `:focus-visible`, offset 1px, declared in `@layer base`
in `globals.css`. `:focus` stays bare, so a mouse click never draws a ring and a
`role="tab"` host never looks stuck.

A control that draws its own indicator opts out with `focus-ring-none` (or
Tailwind's `focus-visible:outline-none`). Both are utilities, which is why the
global rule has to live in `@layer base` — an unlayered rule would outrank every
utility regardless of specificity.

`--ring` is a real accent: every built-in theme sets it to its `primary`, and the
pre-theme fallback in `tokens.css` matches. It used to equal `--border-strong`,
which is why a focus ring was indistinguishable from a border.

**Disabled** (decision 31). One treatment, everywhere:
`disabled:opacity-50 disabled:cursor-not-allowed`. Every `src/ui` primitive
carries exactly that pair. For an element that cannot take `:disabled` — a `div`
acting as a control — use the `disabled-look` utility. Do not invent a third
opacity; the audit found five (30 / 40 / 45 / 50 / 60).

## Primitives

`src/ui/` (decision 32). Variants come from `class-variance-authority`, which is
the only dependency Foundations added.

Each file is shaped like shadcn's **base-style** component — same file name, same
exported `<name>Variants`, same `variant` / `size` prop pair, same `data-slot` —
so later `shadcn add` output drops in with the classes swapped rather than the
structure rewritten. Two deliberate departures:

- **Sizes are Atlas control heights**, not shadcn's 32/36/40px.
- **No `asChild` on `Button`.** shadcn's buttons lean on a Slot primitive, and
  Foundations was allowed one new dependency. Compose instead:
  `<a className={buttonVariants({ variant: "ghost" })}>`. The overlay
  primitives, which arrived with Base UI, do take Base UI's `render` prop —
  that is the same idea under the name Base UI gives it.

| primitive | reach for it when |
|---|---|
| `Button` | the control has a visible text label. Six variants: `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`. `md` (26px) is the default size. |
| `IconButton` | the control is a glyph and nothing else. `label` is **required** and becomes the `aria-label`; wrap it in `Tooltip` to show the same string. The square is a control height and the glyph is one step below it. |
| `Input` | a single-line text field. It keeps the global focus ring and lifts its border to `--border-focus`. For a secret, `SecretInput` already wraps it. |
| `Badge` | a short status word. Seven variants, four of them the status roles (`destructive`, `success`, `warning`, `info`). Not a control, so not on the control-height scale. |
| `Kbd` | the content is a keystroke. `KbdCombo combo="⌘⇧F"` and `KbdKeys keys={[…]}` are the two forms the app uses. |
| `Tooltip` / `Hint` | a hint for an icon-only control. `Hint` is the one-liner; `Tooltip`/`TooltipTrigger`/`TooltipContent` is the composed form. Timing comes from `tooltip-timing.ts`, not from the library. |
| `Dialog` | a centred modal. `DialogOverlay` is the scrim (Base UI calls it the Backdrop), `DialogContent` the panel. No Positioner — a centred modal places itself. |
| `Popover` | anchored content that is not a list of commands. |
| `DropdownMenu` | a list of commands anchored to a trigger. Base UI has no "DropdownMenu": a trigger-anchored menu *is* `Menu`, and the wrapper renames it back. |
| `ContextMenu` | the same list, opened by right-click at the pointer. |

Those five overlay primitives arrived with the Base UI migration (decision 16).
Three rules they all share, because Base UI's anatomy differs from Radix's:

- **`Portal > Positioner > Popup`** for anything anchored (popover, both menus,
  tooltip). A centred dialog has no Positioner.
- **Positioning props belong to the Positioner.** Each wrapper *declares*
  `side` / `sideOffset` / `align` / `alignOffset` and *forwards* them. Left in
  `...props` they land on the Popup, and positioning silently stops working —
  no type error, no lint error.
- **The z-index belongs to the Positioner too.** The Popup is statically
  positioned inside it, so `z-popover` on the Popup would do nothing at all.
  `z-popover` (200) sits above `z-modal` (110) so a menu opened inside a dialog
  escapes it.

`@base-ui/react` is the only dependency the migration added, and the five
`@radix-ui/*` packages were removed with it. `components.json` names the
`base-nova` style, so a future `shadcn add` delivers Base UI variants rather
than Radix ones — its classes still need swapping for house tokens.

Hover colour comes from real tokens (`bg-primary-hover`), never from a `/90`
opacity modifier: Tailwind v4 compiles those to `color-mix()`, and decision 14
puts the floor at macOS 11 / WKWebView.

## The ratchet

`tests/design-system-ratchet.test.ts` is the eleventh contract suite. Nothing
else in the toolchain can see this drift — a new `text-[11.5px]` type-checks,
lints and renders.

**What it counts**, across `src/features/**` and `src/components/**`:

| rule | pattern |
|---|---|
| `arbitrary-text-size` | `text-[…px]` and friends |
| `arbitrary-z-index` | `z-[…]` |
| `arbitrary-shadow` | `shadow-[…]` |
| `arbitrary-radius` | `rounded-[…]`, any corner |
| `colour-literal` | `#rrggbb`, `rgb(`, `rgba(`, `hsl(`, `hsla(` |
| `bg-white-black` | `bg-white`, `bg-black`, with or without an opacity modifier |
| `inline-numeric-style` | inline `zIndex:`, `fontSize:`, `boxShadow:` with a literal |

`src/ui` and `src/styles` are out of scope — they *define* these values.
`src/dev` is out of scope — it never ships.

**It is closed.** It ran as a ratchet through the sweep — committed counts in a
baseline file that could only go down — and the sweep drove **every rule to
zero**. The baseline file is gone and the assertions are `=== 0`, so a new
violation fails outright rather than being absorbed.

Which means the exits have to be real ones:

- **`EXEMPT_FILES`** — a whole file, with the argument written next to the path.
  Two shapes qualify: the file *defines* the scale (`theme-key-registry.ts`,
  `color.ts`), or the colour is *not Atlas's to choose* — a third party's brand
  mark (`agent-brand.ts`, `agent-icons.tsx`), a palette the **user** picks a
  value from (spaces sticky notes, knowledge covers, PDF ink), or something that
  has to survive being shown over content Atlas did not draw.
- **`ratchet-allow: <reason>`** — one site inside an otherwise ordinary file.
  Put it in a comment on the line, or anywhere in the comment block directly
  above it. The rest of the file keeps being scanned, which a whole-file entry
  gives up.

Both demand prose and both are checked: a marker with under 20 characters of
reason, or an exempt file with under 40, fails the suite on its own. That is the
point — the record of *why* is the thing being enforced, not the count.

What survives today, so the shape is clear: the vendors' agent marks, the
user-pickable palettes (spaces, knowledge covers, PDF ink), the colour resolver
and its fixtures, the ANSI `rgb()` string builder in the terminal, the
post-crash error boundary, per-identity avatar hues, pixi's numeric `fontSize`,
mermaid's own `themeVariables`, the PDF page and the lightbox matte (decision
3), Windows' close-button red, and the dev-build badge.

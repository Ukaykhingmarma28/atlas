# ADR-0024: Surfaces sit beside the session; destinations take the window

**Status:** Accepted (2026-10-23).

**For agents:** every tab type has exactly one placement, in `TAB_PLACEMENT`
(`src/lib/constants.ts`): `session`, `surface` or `destination`. Adding a tab type without
one is a compile error. Read the test below before choosing; don't add a type to a second
list to get round it. `tests/tab-placement-contract.test.ts` checks the rest.

## Context

The flat shell (#424) made the main column the session's alone and sent every other tab type
to the surfaces pane beside it. Two kinds of panel were treated as one:

- **Tools you work with beside a session:** the editor, a terminal, the browser, a diff,
  source control, team chat. These are built for a column and are fine at 320–600px.
- **Places you go to:** Timeline, Usage, Knowledge, the knowledge graph, Memory, Spaces. Each
  was designed as a full page, with its own sidebar, board, dashboard or canvas. Squeezed into
  a third of the window, they broke.

There were two ways to fix the second group. Making every panel responsive (desktop, tablet,
phone) is a large design job, and the narrow forms of a board or a graph would be poor: they
would degrade rather than work. Desktop tools rarely do it. They split side panels from full
views instead.

## Decision

**Every tab type has one placement, chosen by one test.**

> Do you use it *while* working in a session, and does it have a useful form at column width
> (about 320–600px)? Yes to both → **surface**. No to either → **destination**.

Signs that something is a destination: it has its own navigation (a sidebar or an inspector),
it is a board, dashboard, canvas or graph, or it is about the whole project or organisation
rather than the task in front of you.

- **Session** (`chat`): the main column, which shows no tab strip.
- **Surface:** a tab in the surfaces pane beside the session. Each surface declares a
  `minWidth` in pixels, and a column showing it will not resize below that.
- **Destination:** it takes the area right of the rail, one at a time, like Settings takes the
  window. The session keeps running underneath. Opening another destination replaces it.
  Esc, the header's back arrow, or the destination's own shortcut return to the session.
  Opening or focusing any session or surface returns as well. A destination stays mounted
  while hidden, so going back to it is instant.

**Peeks are added on request, never by default.** A *peek* is a compact view of a destination,
designed for a column on purpose, that can sit beside the session. None exists yet. The first
one adds a `peek` field to the destination's placement entry and a component made for the
narrow width. A full page is never put in a column as is.

**The store enforces placement on every path.** `addTab`, project restore, layout templates,
zen and closing a column all read `TAB_PLACEMENT`. A destination never enters a column, and the
editor state never saves one.

**Settings stays separate.** It is not a tab type and keeps its own full-window screen: it is
org-agnostic, it covers the rail too, and it has its own navigation and search.

## Consequences

- Timeline, Usage, Knowledge, the knowledge graph, Memory and Spaces open as destinations.
  None of them appears in the ⌘T launcher, a layout template or zen. The Research template
  becomes the session beside a browser, the Usage template is removed, and zen is Session │
  Browser.
- You cannot put Timeline beside a session. That is the trade-off: when someone needs to, the
  answer is a peek, not a column.
- Team chat moves from its own right slot to a surface tab with a 320px floor. It belongs to
  the window, not a project (`WINDOW_TYPES`), so it follows you between projects.
- A new tab type has to answer the test before it compiles, and the contract suite checks that
  no destination is offered as a surface.

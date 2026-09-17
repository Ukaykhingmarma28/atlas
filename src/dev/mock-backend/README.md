# The browser mock backend

`bun run dev` runs the whole Atlas frontend in an ordinary browser against this
fake backend: Tauri's `mockIPC` answers every `invoke()` and `listen()` with
made-up data, so any screen can be opened, themed and reviewed without starting
a Rust build, an agent, or a real git operation.

Start here: `install.ts` explains how it is loaded and in what order a command
is answered. `types.ts` defines a scenario. `scenarios/base.ts` is the wiring
point — every fixture file's handlers are spread into it.

```
localhost:1420/                     # the rich default scenario
localhost:1420/?scenario=git-conflict
```

The badge bottom-right counts **unmocked** commands. Click it to list them, or
run `__atlasMock.unmocked()` in the console. An unmocked command resolves
`null`, so an empty or broken panel is usually a missing fake here, not a UI
bug. `__atlasMock.actions.<name>()` fires a scenario's console triggers.

## Native-only surfaces

Three things in Atlas are not `invoke()` calls, so nothing in this directory
can stand in for them. A visual review done in the browser has not covered
them, and a change that touches one has to be checked in `bun run dev:app`:

- **The Browser tab.** It is a real child `WebviewWindow` positioned over the
  panel by the native window server. In the browser the panel draws its own
  chrome — tab strip, address bar, reader pane — around an empty area where the
  page would be. The `browser_embed_*` commands are answered as no-ops in
  `fixtures/misc.ts` so the badge stays honest about what is _missing_ rather
  than about what is _native_; `fetch_readable` is faked, because reader mode is
  ordinary themed HTML that Rust produces and the webview does not.
- **Finder drag-and-drop.** Dropping files onto the window, and pasting files
  from Finder, arrive through Tauri's native drag-drop channel and the
  `clipboard_file_paths` command reading the macOS pasteboard. The browser's own
  drag-and-drop is a different event with different data, so the in-app drop
  targets (chat attachments, the canvas, the comms composer, the explorer's
  move-by-drag) cannot be exercised here.
- **Native window chrome.** The traffic lights, the window's rounded corners and
  edge shadow, full-screen behaviour, the menu bar and the single-instance
  handoff are drawn by macOS, not by CSS. `window_zoom` and the
  `plugin:window|*` commands are answered so nothing throws, but the titlebar
  rendered in the browser is only the part Atlas draws itself.

Two more differences are worth remembering even where the fake works: Chrome is
not WKWebView (a final look in `bun run dev:app` is still the deciding one), and
this whole directory is injected by a `serve`-only Vite plugin and is a no-op
inside Tauri, so it never ships and never affects `dev:app`.

## Adding a fake

1. Find the command's return shape in `src-tauri/src/commands/<domain>.rs` —
   check the serde renaming, it is not always camelCase.
2. Put the fixture in `fixtures/<domain>.ts` and type it with the **frontend's**
   own API type, so `bun run typecheck` fails when Rust's shape drifts. A type
   declared inline in a component and not exported gets restated in the fixture
   file with a comment naming where it came from.
3. Spread the handlers into `scenarios/base.ts`.
4. Cover states, not happy paths: long names, errors, loading, empty, selected,
   disabled, unread, conflicted, running, cancelled. Colour lives in states, and
   this backend exists so a theme can be judged against them.
5. Make mutating commands mutate module-level state, so clicking changes what
   the screen shows.

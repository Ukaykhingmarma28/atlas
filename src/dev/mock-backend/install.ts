// Dev-only fake backend: lets the Atlas frontend run in a normal browser under
// `bun run dev`, with made-up data standing in for Rust.
//
// Every piece of data a screen shows arrives through `invoke()` or `listen()`
// (the frontend never touches the filesystem), so replacing those two with
// Tauri's own `mockIPC` is enough for any screen to render.
//
// How it is loaded: `vite.config.ts` injects this file as its own <script>
// ahead of `main.tsx`, and only when Vite is serving (never in a build).
//
// Inside the real app (`bun run dev:app` loads the same dev server) Tauri has
// already set `isTauri`, and this file does nothing — and loads nothing: the
// fixtures (~18k lines) live behind a dynamic `import()` of `backend.ts`, so
// the Tauri window never fetches or evaluates them.
//
// That split is also why this file is in two halves. The half the app can
// observe synchronously has to be in place before `main.tsx` evaluates, and a
// dynamic import resolves too late for that (a sibling module script does not
// wait for this one's promises), so it stays here and stays synchronous:
//   - the `window.__TAURI_INTERNALS__` shims `mockWindows` / `mockConvertFileSrc`
//     install, which app modules read at import time;
//   - `mockIPC` itself, so `listen()` and `new Channel()` register against the
//     one callback table every later event uses. Its handler waits for the
//     backend to load before answering, so a command the app sends first
//     simply resolves a little later.
// Everything else — fixtures, scenarios, the badge — is `backend.ts`.

import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { MockBackend } from "./backend";

/** The scenario `?scenario=` asks for, or the default. Exported so a caller
 *  that wants the URL's answer can take it without re-parsing. */
export function scenarioFromUrl(search: string = location.search): string {
  return new URLSearchParams(search).get("scenario") ?? "default";
}

/**
 * Install the fake backend, answering as `scenarioName`. Resolves once the
 * fixtures have loaded; commands sent before then are answered after it.
 *
 * The argument is the whole point (decision 41): the mock used to read
 * `?scenario=` itself, which meant the URL was the ONLY way to choose one. A
 * Storybook decorator has no URL to set — it renders N stories in one document
 * and wants a different scenario per story — so the scenario had to become a
 * parameter before anything else depended on it being global. The URL is still
 * the default, so `bun run dev` is unchanged.
 *
 * Storybook itself is not in scope; this only keeps the door open.
 */
export function installMockBackend(scenarioName: string = scenarioFromUrl()): Promise<void> {
  const ready: Promise<MockBackend> = import("./backend").then((m) =>
    m.startMockBackend(scenarioName),
  );

  // `mockIPC`'s unlisten drops the callback but not its event registration, so
  // every later emit on that event warns about a missing callback. Harmless;
  // hide it so real warnings stay readable.
  const warn = console.warn.bind(console);
  console.warn = (...a: unknown[]) => {
    if (typeof a[0] === "string" && a[0].startsWith("[TAURI] Couldn't find callback id")) return;
    warn(...a);
  };

  mockWindows("main");
  mockConvertFileSrc("macos");
  // The media viewer bypasses `invoke()` and hands the webview an `asset://`
  // URL, which resolves to nothing in a plain browser. Serve the seeded binary
  // files as `data:` URLs instead so an image tab actually shows an image;
  // anything else keeps Tauri's answer (a broken image — the real "file is
  // gone" state). Nothing asks before the backend has loaded — a path to show
  // comes from an answered command — but until then Tauri's answer stands.
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__: { convertFileSrc: (p: string, protocol?: string) => string };
    }
  ).__TAURI_INTERNALS__;
  const tauriConvert = internals.convertFileSrc.bind(internals);
  let assetUrl: MockBackend["assetUrl"] | null = null;
  internals.convertFileSrc = (filePath: string) =>
    assetUrl ? assetUrl(filePath, tauriConvert) : tauriConvert(filePath);

  mockIPC(async (cmd, args) => (await ready).answer(cmd, args), { shouldMockEvents: true });

  return ready.then((backend) => {
    assetUrl = backend.assetUrl;
  });
}

/** Drop every Zustand store back to how it booted (decision 41). Loaded on
 *  demand for the same reason as the fixtures. */
export async function resetStores(): Promise<string[]> {
  return (await import("./reset-stores")).resetStores();
}

// The `serve`-only Vite plugin injects this file as its own module script, so
// loading it IS the install. Inside Tauri the shell has already set `isTauri`
// and there is a real backend, so it stands down.
if (!(globalThis as { isTauri?: boolean }).isTauri) void installMockBackend();

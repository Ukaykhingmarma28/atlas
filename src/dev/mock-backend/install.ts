// Dev-only fake backend: lets the Atlas frontend run in a normal browser under
// `bun run dev`, with made-up data standing in for Rust.
//
// Every piece of data a screen shows arrives through `invoke()` or `listen()`
// (the frontend never touches the filesystem), so replacing those two with
// Tauri's own `mockIPC` is enough for any screen to render.
//
// How it is loaded: `vite.config.ts` injects this file as its own <script>
// ahead of `main.tsx`, and only when Vite is serving (never in a build). It
// must stay synchronous — no top-level await — so the mock is in place before
// any app module evaluates and calls `invoke()`.
//
// Inside the real app (`bun run dev:app` loads the same dev server) Tauri has
// already set `isTauri`, and this file does nothing.
//
// Answer order for each command:
//   1. the active scenario's `commands`   (`?scenario=<name>`)
//   2. `baseHandlers`                     (what the app needs to start)
//   3. fallback: resolves `null` and is listed as unmocked (console + badge)

import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { baseHandlers } from "./scenarios/base";
import { scenarios } from "./scenarios";
import { mountBadge } from "./badge";
import { resetStores } from "./reset-stores";
import { mockAssetUrl } from "./fixtures/files";
import type { MockArgs } from "./types";

declare global {
  interface Window {
    /** Console / Claude-in-Chrome handle on the mock backend. */
    __atlasMock?: {
      scenario: string;
      unmocked: () => string[];
      calls: () => { cmd: string; args: MockArgs | undefined }[];
      emit: typeof emit;
      actions: Record<string, () => void | Promise<void>>;
      /** Drop every Zustand store back to how it booted (decision 41). */
      resetStores: () => Promise<string[]>;
    };
  }
}

/** The scenario `?scenario=` asks for, or the default. Exported so a caller
 *  that wants the URL's answer can take it without re-parsing. */
export function scenarioFromUrl(search: string = location.search): string {
  return new URLSearchParams(search).get("scenario") ?? "default";
}

/**
 * Install the fake backend, answering as `scenarioName`.
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
export function installMockBackend(scenarioName: string = scenarioFromUrl()): void {
  const name = scenarioName;
  const scenario = scenarios[name];
  if (!scenario) {
    console.error(
      `[mock-backend] unknown scenario "${name}". Known: ${Object.keys(scenarios).join(", ")}`,
    );
  }

  const unmocked = new Map<string, number>();
  const calls: { cmd: string; args: MockArgs | undefined }[] = [];
  const onUnmocked = mountBadge(name, () => [...unmocked.keys()]);

  scenario?.init?.();

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
  // gone" state).
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__: { convertFileSrc: (p: string, protocol?: string) => string };
    }
  ).__TAURI_INTERNALS__;
  const tauriConvert = internals.convertFileSrc.bind(internals);
  internals.convertFileSrc = (filePath: string) => mockAssetUrl(filePath, tauriConvert);
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as MockArgs;
      if (calls.length < 2000) calls.push({ cmd, args: a });

      const handler = scenario?.commands?.[cmd] ?? baseHandlers[cmd];
      if (handler) return handler(a);

      if (!unmocked.has(cmd)) {
        console.warn(`[mock-backend] unmocked: ${cmd}`, a);
        onUnmocked();
      }
      unmocked.set(cmd, (unmocked.get(cmd) ?? 0) + 1);
      return null;
    },
    { shouldMockEvents: true },
  );

  window.__atlasMock = {
    scenario: name,
    unmocked: () => [...unmocked.keys()].sort(),
    calls: () => calls,
    emit,
    actions: scenario?.actions ?? {},
    resetStores,
  };

  if (scenario?.setup) {
    const run = scenario.setup;
    window.addEventListener(
      "atlas:app-ready",
      () => {
        // Let the first commit settle so stores have hydrated before the
        // scenario opens tabs or fires events.
        setTimeout(() => void run(), 0);
      },
      { once: true },
    );
  }

  console.info(`[mock-backend] active — scenario "${name}"`);
}

// The `serve`-only Vite plugin injects this file as its own module script, so
// loading it IS the install. Inside Tauri the shell has already set `isTauri`
// and there is a real backend, so it stands down.
if (!(globalThis as { isTauri?: boolean }).isTauri) installMockBackend();

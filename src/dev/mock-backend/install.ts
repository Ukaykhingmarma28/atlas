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
    };
  }
}

function install(): void {
  const params = new URLSearchParams(location.search);
  const name = params.get("scenario") ?? "default";
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

if (!(globalThis as { isTauri?: boolean }).isTauri) install();

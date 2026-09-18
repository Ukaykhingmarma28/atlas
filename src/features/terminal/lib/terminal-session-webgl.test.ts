// @vitest-environment happy-dom
//
// The page-wide WebGL context budget (`MAX_WEBGL` in `terminal-session.ts`).
// `disposeXterm()` and a WebglAddon's own `onContextLoss` callback both
// release a context back to the shared counter, and a context loss that
// arrives for an addon this session already disposed must not decrement the
// counter a second time — the same double-release shape the pixi teardown
// fix (`src/lib/pixi-app.ts`) closed for the Knowledge Graph / Memory graphs.
// A regression here means the budget undercounts live contexts and Atlas
// hands out more than WKWebView's real cap.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() =>
  vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
);
const channels = vi.hoisted(() => [] as Array<{ onmessage: ((p: ArrayBuffer) => void) | null }>);

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: ((p: ArrayBuffer) => void) | null = null;
    constructor() {
      channels.push(this);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../utils/resolve-font", () => ({
  resolveTerminalFont: () => Promise.resolve("monospace"),
}));
vi.mock("./terminal-notifier", () => ({ createTerminalEventSink: () => () => {} }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    unicode = { activeVersion: "" };
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {}
    onData() {}
    write() {}
    dispose() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return "";
    }
    selectAll() {}
    focus() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {},
}));

// One fake per `new WebglAddon()` — mirrors the real addon's per-instance
// `onContextLoss` event closely enough to drive both release paths: the
// session's own `disposeXterm()`, and a (possibly late, possibly stale)
// context-loss signal.
const { webglInstances, FakeWebglAddon } = vi.hoisted(() => {
  class FakeWebglAddon {
    disposed = false;
    private lossCb: (() => void) | null = null;
    onContextLoss(cb: () => void): void {
      this.lossCb = cb;
    }
    dispose(): void {
      this.disposed = true;
    }
    /** Test hook: simulate the addon reporting a context loss. */
    triggerContextLoss(): void {
      this.lossCb?.();
    }
  }
  return { webglInstances: [] as FakeWebglAddon[], FakeWebglAddon };
});
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class extends FakeWebglAddon {
    constructor() {
      super();
      webglInstances.push(this);
    }
  },
}));

import { terminalSessions, liveWebglCount } from "./terminal-session";
import { useTerminalStore } from "../stores/terminal-store";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const tick = () => new Promise((r) => setTimeout(r, 0));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
const ALT_ENTER = "\x1b[?1049h";

let ptyCounter = 0;
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd) => {
    if (cmd === "terminal_create") return Promise.resolve(`pty-${++ptyCounter}`);
    if (cmd === "terminal_zsh_dir") return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
  channels.length = 0;
  webglInstances.length = 0;
  useTerminalStore.setState({ tabs: {}, busy: {}, pendingCommands: {}, owners: {} });
});

afterEach(() => terminalSessions.closeAll());

/** Acquire a session, attach a host and make it visible — the preconditions
 * `ensureXterm()` checks before creating a surface. */
async function openVisibleSession(key: string) {
  const s = terminalSessions.acquire(key, { tabId: "t", cwd: "/tmp" });
  await tick();
  const host = document.createElement("div");
  document.body.appendChild(host);
  s.attach(host);
  s.setVisible(true);
  return { s, host, ch: channels[channels.length - 1] };
}

/** Drive the session into the alt screen, which lazily creates its xterm +
 * WebGL surface. */
async function enterAltScreen(ch: { onmessage: ((p: ArrayBuffer) => void) | null }) {
  ch.onmessage?.(bytes(ALT_ENTER));
  await frame();
  await vi.waitFor(() => expect(webglInstances.length).toBeGreaterThan(0));
}

describe("terminal WebGL budget", () => {
  it("a stale context-loss for an already-disposed addon does not re-decrement a live budget", async () => {
    // Session A opens a WebGL surface, then closes normally (disposeXterm
    // releases its addon and the count goes back to 0).
    const a = await openVisibleSession(`a-${Math.random()}`);
    await enterAltScreen(a.ch);
    expect(liveWebglCount()).toBe(1);
    const staleAddon = webglInstances[0]!;
    await a.s.close();
    expect(staleAddon.disposed).toBe(true);
    expect(liveWebglCount()).toBe(0);

    // Session B opens its own WebGL surface afterwards — a genuinely live
    // context the budget must keep counting.
    const b = await openVisibleSession(`b-${Math.random()}`);
    await enterAltScreen(b.ch);
    expect(liveWebglCount()).toBe(1);

    // A's context-loss handler — registered before A closed — fires late,
    // for the addon A already disposed. It must be a no-op against the
    // shared counter: A's release already happened, and the count in scope
    // right now belongs to B's still-live context.
    staleAddon.triggerContextLoss();
    expect(liveWebglCount()).toBe(1);

    await b.s.close();
    expect(liveWebglCount()).toBe(0);

    a.host.remove();
    b.host.remove();
  });

  it("a genuine context loss on a live session releases its own context once", async () => {
    const a = await openVisibleSession(`c-${Math.random()}`);
    await enterAltScreen(a.ch);
    expect(liveWebglCount()).toBe(1);
    const addon = webglInstances[0]!;

    addon.triggerContextLoss();
    expect(liveWebglCount()).toBe(0);
    // A second, redundant firing (or disposeXterm running later during
    // close) must not go negative or double-release.
    addon.triggerContextLoss();
    expect(liveWebglCount()).toBe(0);

    await a.s.close();
    expect(liveWebglCount()).toBe(0);
    a.host.remove();
  });
});

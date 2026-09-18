import { describe, expect, it } from "vitest";
import type { Application } from "pixi.js";
import { destroyPixiApp, livePixiAppCount, registerPixiApp } from "./pixi-app";

/**
 * A stand-in for a pixi `Application` that records what `destroy` was handed.
 * Only `destroy` is ever touched by this module.
 */
function fakeApp() {
  const calls: unknown[][] = [];
  const app = {
    destroy: (...args: unknown[]) => {
      calls.push(args);
    },
  } as unknown as Application;
  return { app, calls };
}

/** The renderer options of the single `destroy` call, or `undefined`. */
function rendererOptions(calls: unknown[][]) {
  return calls[0]?.[0] as { removeView?: boolean; releaseGlobalResources?: boolean } | undefined;
}

describe("destroyPixiApp", () => {
  it("keeps pixi's process-global pools while another Application is alive", () => {
    // The bug: `app.destroy(true, …)` releases the module-singleton batch/
    // texture/canvas pools, and the OTHER live renderer then throws
    // "Cannot read properties of null (reading 'clear')" inside
    // `DefaultBatcher.break` on its next tick, one frame after the destroy —
    // too late for any try/catch around destroy to see it.
    const knowledge = fakeApp();
    const memory = fakeApp();
    registerPixiApp(knowledge.app);
    registerPixiApp(memory.app);

    destroyPixiApp(memory.app);

    expect(rendererOptions(memory.calls)?.releaseGlobalResources).toBe(false);
    expect(livePixiAppCount()).toBe(1);

    // ...and releases them once the last one goes, which is when it is safe.
    destroyPixiApp(knowledge.app);

    expect(rendererOptions(knowledge.calls)?.releaseGlobalResources).toBe(true);
    expect(livePixiAppCount()).toBe(0);
  });

  it("still removes the canvas", () => {
    const { app, calls } = fakeApp();
    registerPixiApp(app);
    destroyPixiApp(app);
    expect(rendererOptions(calls)?.removeView).toBe(true);
    expect(calls[0]?.[1]).toEqual({ children: true });
  });

  it("is a no-op for an app that was already destroyed", () => {
    // Both the unmount cleanup and the resolved `init()` promise can reach
    // destroy for the same Application; the second must not decrement twice
    // (which would release the pools out from under a surviving app).
    const first = fakeApp();
    const second = fakeApp();
    registerPixiApp(first.app);
    registerPixiApp(second.app);

    destroyPixiApp(first.app);
    destroyPixiApp(first.app);

    expect(first.calls).toHaveLength(1);
    expect(livePixiAppCount()).toBe(1);

    destroyPixiApp(second.app);
    expect(rendererOptions(second.calls)?.releaseGlobalResources).toBe(true);
    expect(livePixiAppCount()).toBe(0);
  });

  it("is a no-op for an app that was never registered", () => {
    const { app, calls } = fakeApp();
    destroyPixiApp(app);
    expect(calls).toHaveLength(0);
    expect(livePixiAppCount()).toBe(0);
  });
});

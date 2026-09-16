import { describe, expect, it, vi } from "vitest";
import { createWakeRefresher, type WakeRefresherOptions } from "./refresh-on-wake";

const INTERVAL = 5 * 60_000;

function setup(over: Partial<WakeRefresherOptions> = {}) {
  let now = 1_000_000;
  const refresh = vi.fn(() => Promise.resolve());
  const onWake = createWakeRefresher({
    refresh,
    isSignedIn: () => true,
    minIntervalMs: INTERVAL,
    now: () => now,
    ...over,
  });
  return { refresh, onWake, advance: (ms: number) => (now += ms) };
}

describe("createWakeRefresher", () => {
  it("does not re-pull on a wake right after creation — launch just pulled", () => {
    const { refresh, onWake } = setup();
    onWake();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-pulls on the first wake after the interval while signed in", () => {
    const { refresh, onWake, advance } = setup();
    advance(INTERVAL);
    onWake();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("coalesces wakes inside the interval into one pull", () => {
    const { refresh, onWake, advance } = setup();
    advance(INTERVAL);
    onWake();
    advance(60_000);
    onWake();
    advance(60_000);
    onWake();
    expect(refresh).toHaveBeenCalledTimes(1);
    advance(INTERVAL - 2 * 60_000);
    onWake();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing signed out, and does not burn the interval", () => {
    let signedIn = false;
    const { refresh, onWake, advance } = setup({ isSignedIn: () => signedIn });
    advance(INTERVAL);
    onWake();
    expect(refresh).not.toHaveBeenCalled();
    signedIn = true;
    onWake();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed pull and allows the next one after the interval", async () => {
    const refresh = vi.fn(() => Promise.reject(new Error("offline")));
    const { onWake, advance } = setup({ refresh });
    advance(INTERVAL);
    onWake();
    await Promise.resolve();
    advance(INTERVAL);
    expect(() => onWake()).not.toThrow();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

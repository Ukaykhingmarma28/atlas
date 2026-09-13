import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadlineError, describeMs, isDeadlineError, withDeadline } from "./with-deadline";

describe("withDeadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes a value through when the hop settles in time", async () => {
    const p = withDeadline(Promise.resolve(42), 1000, "x");
    await expect(p).resolves.toBe(42);
  });

  it("passes the hop's own rejection through untouched", async () => {
    const boom = { message: "spawn failed", kind: "spawn" };
    const p = withDeadline(Promise.reject(boom), 1000, "x");
    await expect(p).rejects.toBe(boom);
  });

  it("rejects with a tagged DeadlineError naming the hop once the deadline passes", async () => {
    const never = new Promise<void>(() => {});
    const p = withDeadline(never, 180_000, "Codex has not answered `session/new`");
    const settled = p.then(
      () => "resolved",
      (e: unknown) => e,
    );
    vi.advanceTimersByTime(179_999);
    await Promise.resolve();
    vi.advanceTimersByTime(1);
    const err = await settled;
    expect(err).toBeInstanceOf(DeadlineError);
    expect(isDeadlineError(err)).toBe(true);
    expect((err as DeadlineError).code).toBe("bind-timeout");
    expect((err as DeadlineError).message).toBe(
      "Codex has not answered `session/new` in 3 minutes",
    );
  });

  it("does not fire the deadline after the hop settled", async () => {
    let resolve!: (v: number) => void;
    const hop = new Promise<number>((r) => (resolve = r));
    const p = withDeadline(hop, 1000, "x");
    resolve(7);
    await expect(p).resolves.toBe(7);
    // Advancing past the deadline must not surface an unhandled rejection.
    vi.advanceTimersByTime(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-arms while the hop reports progress, and rejects once it stops", async () => {
    const never = new Promise<void>(() => {});
    let working = true;
    const settled = withDeadline(never, 1000, "x", () => working).then(
      () => "resolved",
      (e: unknown) => e,
    );
    vi.advanceTimersByTime(3500);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    working = false;
    vi.advanceTimersByTime(1000);
    expect(isDeadlineError(await settled)).toBe(true);
  });

  it("isDeadlineError rejects ordinary errors and backend rejections", () => {
    expect(isDeadlineError(new Error("nope"))).toBe(false);
    expect(isDeadlineError({ message: "x", kind: "auth" })).toBe(false);
    expect(isDeadlineError(null)).toBe(false);
  });

  it("describeMs reads naturally", () => {
    expect(describeMs(180_000)).toBe("3 minutes");
    expect(describeMs(60_000)).toBe("1 minute");
    expect(describeMs(30_000)).toBe("30 seconds");
  });
});

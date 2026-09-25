import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { queueWatch } = await import("./watch-queue");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let every settled promise run its continuations. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invoke.mockReset();
});

describe("queueWatch", () => {
  it("runs subscribe, unsubscribe, subscribe strictly in call order", async () => {
    // StrictMode's double mount. If the second subscribe ever overtook the
    // unsubscribe, the Session ended unsubscribed with nothing left to fix it.
    const first = deferred();
    const second = deferred();
    const third = deferred();
    invoke
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);

    void queueWatch("ws_1", "ses_1");
    void queueWatch("ws_1", null);
    const last = queueWatch("ws_1", "ses_1");

    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    first.resolve();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    second.resolve();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(3);
    third.resolve();
    await last;

    expect(invoke.mock.calls.map((c) => c[1])).toEqual([
      { projectId: "ws_1", sessionId: "ses_1" },
      { projectId: "ws_1", sessionId: null },
      { projectId: "ws_1", sessionId: "ses_1" },
    ]);
  });

  it("keeps going after a failed watch", async () => {
    invoke.mockRejectedValueOnce(new Error("no socket")).mockResolvedValueOnce(undefined);
    await queueWatch("ws_1", "ses_1");
    await queueWatch("ws_1", "ses_2");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[1]).toEqual({ projectId: "ws_1", sessionId: "ses_2" });
  });
});

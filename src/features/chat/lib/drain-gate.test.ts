import { describe, expect, it } from "vitest";
import { drainEdge } from "./drain-gate";

const base = {
  prevStatus: "running" as string | null,
  curStatus: "idle",
  prevAcp: "acp-1" as string | undefined,
  curAcp: "acp-1" as string | undefined,
  prevResuming: false,
  curResuming: false,
};

describe("drainEdge", () => {
  it("drains the queue when a turn ends on a bound session", () => {
    const edge = drainEdge(base);
    expect(edge.turnFinished).toBe(true);
    expect(edge.drainQueue).toBe(true);
  });

  it("does NOT drain when a bind failure drops a starting tab back to idle", () => {
    // The 2026-09-14 loop: `pendingSend` held the first message with the
    // status `running` and no session; the failure branch re-queued it and
    // set `idle`. That edge must not shift the queue back into `handleSend`.
    const edge = drainEdge({ ...base, prevAcp: undefined, curAcp: undefined });
    expect(edge.turnFinished).toBe(false);
    expect(edge.justBound).toBe(false);
    expect(edge.drainQueue).toBe(false);
  });

  it("does NOT drain when Stop clears a held message before the bind landed", () => {
    const edge = drainEdge({
      ...base,
      prevAcp: undefined,
      curAcp: undefined,
      curStatus: "idle",
    });
    expect(edge.drainQueue).toBe(false);
  });

  it("drains on the bind landing, even while the status reads running", () => {
    const edge = drainEdge({
      ...base,
      prevStatus: "running",
      curStatus: "running",
      prevAcp: undefined,
      curAcp: "acp-2",
    });
    expect(edge.justBound).toBe(true);
    expect(edge.drainQueue).toBe(true);
  });

  it("drains on the resume flag's falling edge only with a session", () => {
    expect(
      drainEdge({ ...base, prevStatus: "idle", prevResuming: true, curResuming: false })
        .justResumed,
    ).toBe(true);
    expect(
      drainEdge({
        ...base,
        prevStatus: "idle",
        prevResuming: true,
        curResuming: false,
        curAcp: undefined,
      }).justResumed,
    ).toBe(false);
  });

  it("stays quiet on a status edge that is not a turn end", () => {
    expect(drainEdge({ ...base, prevStatus: "idle", curStatus: "running" }).drainQueue).toBe(false);
    expect(drainEdge({ ...base, prevStatus: null, curStatus: "idle" }).drainQueue).toBe(false);
  });
});

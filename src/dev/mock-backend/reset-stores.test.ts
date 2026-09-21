import { describe, expect, it } from "vitest";
import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { collectStores, restoreStores, snapshotStores } from "./reset-stores";

interface Counter {
  count: number;
  tags: string[];
  actions: { bump: () => void };
}

function counterStore() {
  return createSelectors(
    create<Counter>()((set) => ({
      count: 0,
      tags: [],
      actions: { bump: () => set((s) => ({ count: s.count + 1 })) },
    })),
  );
}

describe("collectStores", () => {
  it("finds the stores a module exports and ignores everything else", () => {
    const store = counterStore();
    const found = collectStores({
      useCounterStore: store,
      SOME_CONSTANT: 3,
      helper: () => {},
      nothing: null,
      undef: undefined,
    });
    expect([...found.keys()]).toEqual(["useCounterStore"]);
    expect(found.get("useCounterStore")).toBe(store);
  });
});

describe("snapshot / restore", () => {
  it("puts a store back to its snapshot", () => {
    const store = counterStore();
    const baseline = snapshotStores([store]);

    store.getState().actions.bump();
    store.getState().actions.bump();
    expect(store.getState().count).toBe(2);

    restoreStores(baseline);
    expect(store.getState().count).toBe(0);
  });

  it("replaces rather than merges, so a key added after the snapshot is dropped", () => {
    const store = counterStore();
    const baseline = snapshotStores([store]);

    store.setState({ extra: "leaked" } as unknown as Partial<Counter>);
    expect("extra" in store.getState()).toBe(true);

    restoreStores(baseline);
    expect("extra" in store.getState()).toBe(false);
  });

  it("keeps the actions callable after a restore", () => {
    const store = counterStore();
    const baseline = snapshotStores([store]);
    store.getState().actions.bump();
    restoreStores(baseline);

    store.getState().actions.bump();
    expect(store.getState().count).toBe(1);
  });

  it("does not hand the same object back twice, so a setState cannot rewrite the baseline", () => {
    const store = counterStore();
    const baseline = snapshotStores([store]);
    const snapshotted = baseline.get(store)!;

    restoreStores(baseline);
    const first = store.getState();
    restoreStores(baseline);
    const second = store.getState();

    // The thing the name promises: a fresh STATE object each time, and never
    // the baseline's own object.
    expect(first).not.toBe(second);
    expect(first).not.toBe(snapshotted);
    expect(second).not.toBe(snapshotted);

    store.setState({ count: 99 });
    expect((snapshotted as Counter).count).toBe(0);
    restoreStores(baseline);
    expect(store.getState().count).toBe(0);
  });

  it("hands back fresh nested values each restore (the snapshot is deep)", () => {
    const store = counterStore();
    const baseline = snapshotStores([store]);

    restoreStores(baseline);
    const firstTags = store.getState().tags;
    restoreStores(baseline);

    expect(store.getState().tags).not.toBe(firstTags);
    expect(store.getState().tags).not.toBe((baseline.get(store) as Counter).tags);
    expect(store.getState().tags).toEqual([]);
  });

  it("a nested array mutated in place does not survive the next reset", () => {
    const store = counterStore();
    const baseline = snapshotStores([store]);

    restoreStores(baseline);
    const mutated = store.getState().tags;
    mutated.push("mutated in place");
    restoreStores(baseline);

    expect(store.getState().tags).not.toBe(mutated);
    expect(store.getState().tags).toEqual([]);
  });
});

// Per-render store isolation for the mock backend (decision 41).
//
// Atlas's Zustand stores are module singletons: `create(...)` runs once per
// module and every consumer shares that one state. That is right for an app
// with a single window, and wrong for anything that renders the same component
// repeatedly in one document — a Storybook decorator, a screenshot sweep, a
// test file that mounts two panels. The second render inherits whatever the
// first one left behind, and the failure looks like a component bug.
//
// Storybook is NOT in scope. This is the affordance that keeps it possible:
// the reset exists and works now (`__atlasMock.resetStores()` in the console),
// so nothing has to be retrofitted around singletons later.
//
// Everything here is dev-only: the mock backend never ships.

/**
 * The slice of Zustand's vanilla store API this needs.
 *
 * Written in METHOD syntax deliberately. Zustand types `setState` as two
 * overloads (`replace?: false` and `replace: true`), and under
 * `strictFunctionTypes` a property-style signature checks parameters
 * contravariantly, so the `replace?: false` overload makes a real store
 * unassignable to this. Methods are checked bivariantly, which is the right
 * call here: the states involved are opaque objects this module only ever
 * copies.
 */
interface ResettableStore {
  getState(): object;
  setState(state: object, replace: true): void;
  subscribe(listener: () => void): () => void;
}

function isStore(value: unknown): value is ResettableStore {
  if (typeof value !== "function" && typeof value !== "object") return false;
  if (value === null) return false;
  const candidate = value as Partial<ResettableStore>;
  return (
    typeof candidate.getState === "function" &&
    typeof candidate.setState === "function" &&
    typeof candidate.subscribe === "function"
  );
}

/**
 * Every store a module exports, by export name.
 *
 * Exported separately from the glob so it can be unit-tested without loading
 * the app. `createSelectors` (`src/lib/create-selectors.ts`) returns the store
 * itself with a `.use` proxy bolted on, so the wrapped and unwrapped forms are
 * the same object and duck-typing on the vanilla API finds both.
 */
export function collectStores(module: Record<string, unknown>): Map<string, ResettableStore> {
  const found = new Map<string, ResettableStore>();
  for (const [name, value] of Object.entries(module)) {
    if (isStore(value)) found.set(name, value);
  }
  return found;
}

/**
 * Snapshot / restore over a set of stores.
 *
 * `setState(state, true)` REPLACES rather than merges, which matters: a store
 * whose state grew a key since the snapshot must lose it again, or the reset
 * is partial in exactly the way that produces a confusing half-state. Action
 * objects live inside the state here, and they are stable closures over the
 * store's own `set`/`get`, so restoring them by reference is correct.
 */
export function snapshotStores(stores: Iterable<ResettableStore>): Map<ResettableStore, object> {
  return new Map([...stores].map((store) => [store, deepCopy(store.getState())]));
}

export function restoreStores(baseline: Map<ResettableStore, object>): void {
  for (const [store, state] of baseline) store.setState(deepCopy(state), true);
}

/**
 * Copy plain objects, arrays, Maps and Sets all the way down, both when
 * snapshotting and when restoring. A shallow copy would share nested values
 * with the baseline, so code that mutates a nested array in place (a test
 * helper, a console experiment) would poison every later reset.
 *
 * Not `structuredClone`: the state holds action functions, which it rejects.
 * Functions, class instances and anything else non-plain are kept by
 * reference — actions are stable closures, and the stores hold no other
 * mutable instances worth copying.
 */
function deepCopy<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof value !== "object" || value === null) return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached as T;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(deepCopy(item, seen));
    return out as T;
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value) out.set(k, deepCopy(v, seen));
    return out as T;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const v of value) out.add(deepCopy(v, seen));
    return out as T;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) out[k] = deepCopy(v, seen);
  return out as T;
}

// Lazy on purpose. `install.ts` has to stay synchronous and cheap — it runs
// before any app module — and importing 28 store modules eagerly would also
// run their module-level side effects (listeners, hydration) at a moment the
// app has not reached yet.
const storeModules = import.meta.glob<Record<string, unknown>>("../../features/*/stores/*.ts");

let baseline: Map<ResettableStore, object> | null = null;

/**
 * Put every Zustand store back to the state it had the FIRST time this ran.
 *
 * The first call is therefore the one that defines "clean" — call it once
 * before the first render you want isolated, then again between renders.
 * Returns the store export names it touched, so a caller can see it found
 * something rather than silently finding nothing.
 */
export async function resetStores(): Promise<string[]> {
  const names: string[] = [];
  const stores = new Map<string, ResettableStore>();
  for (const [path, load] of Object.entries(storeModules)) {
    if (path.endsWith(".test.ts")) continue;
    for (const [name, store] of collectStores(await load())) {
      stores.set(`${path}#${name}`, store);
      names.push(name);
    }
  }

  if (baseline) restoreStores(baseline);
  // Snapshot AFTER restoring, so a store module imported for the first time by
  // this very call still gets a baseline, and so the baseline grows as the app
  // lazy-loads more features rather than being fixed at the first call.
  const current = snapshotStores(stores.values());
  baseline = baseline ? new Map([...current, ...baseline]) : current;
  return names.sort();
}

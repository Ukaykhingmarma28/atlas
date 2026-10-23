// The project file tree's model: a per-directory cache of listings, the set of
// expanded directories, and the flat row list the virtualizer draws, derived
// from those two.
//
// Why a plain class behind `useSyncExternalStore` rather than a store:
//
//  - Nothing in a row's identity changes when a folder opens. Each listing is
//    turned into row objects once and cached against the listing itself, so
//    flattening is concatenating cached arrays, and a row that was on screen
//    before an expand is the same object after it.
//  - Loads are batched. Every directory asked for in one tick goes out as ONE
//    `read_directories` call, so revealing `a/b/c/d.ts` (four listings) or a
//    watcher burst touching twenty folders costs one IPC round trip.
//  - It outlives the view. The model is cached per project root, so switching
//    the review panel between Changes and Files keeps what was open.
//
// Paths are root-relative and `/`-separated, `""` being the root, as
// `read_directories` answers them.

import type { DirectoryListing, ProjectEntry, ProjectEntryKind } from "./fs-api";

/** One drawn row. Immutable and shared between flattens; see `rowsOf`. */
export interface TreeRowData {
  /** Root-relative. */
  path: string;
  name: string;
  depth: number;
  kind: ProjectEntryKind;
  ignored: boolean;
  /** Starts with a dot: hidden unless the user shows hidden files. */
  hidden: boolean;
}

export interface TreeSnapshot {
  /** Visible rows, depth-first, in listing order. */
  rows: readonly TreeRowData[];
  expanded: ReadonlySet<string>;
  /** Directories whose listing is being fetched for the first time. */
  loading: ReadonlySet<string>;
  /** Directories whose last fetch failed, with why. */
  errors: ReadonlyMap<string, string>;
  /** The root has answered at least once. */
  ready: boolean;
}

export type DirectoryReader = (root: string, paths: string[]) => Promise<DirectoryListing[]>;

/** Paths per `read_directories` call. A watcher burst or an expand-all can ask
 *  for thousands; the backend answers each call in one blocking task, so a
 *  bound keeps any one call short and lets the first answers paint. */
export const BATCH_SIZE = 128;

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Every directory above `path`, root first: `a/b/c.ts` → `["", "a", "a/b"]`. */
export function ancestorsOf(path: string): string[] {
  const out = [""];
  let i = path.indexOf("/");
  while (i >= 0) {
    out.push(path.slice(0, i));
    i = path.indexOf("/", i + 1);
  }
  return out;
}

const depthOf = (path: string) => {
  let depth = 0;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) depth++;
  return depth;
};

/**
 * A listing's rows, built once per listing object. Weak, so a listing replaced
 * by a refresh is collected with its rows.
 */
const rowCache = new WeakMap<readonly ProjectEntry[], TreeRowData[]>();
function rowsOf(entries: readonly ProjectEntry[]): TreeRowData[] {
  let rows = rowCache.get(entries);
  if (!rows) {
    rows = entries.map((entry) => {
      const name = nameOf(entry.path);
      return {
        path: entry.path,
        name,
        depth: depthOf(entry.path),
        kind: entry.kind,
        ignored: entry.ignored === true,
        hidden: name.startsWith("."),
      };
    });
    rowCache.set(entries, rows);
  }
  return rows;
}

/**
 * Depth-first flatten of what is open. A directory that is expanded but not
 * yet loaded contributes its own row only; its children follow once they land.
 * An expanded directory under a collapsed one stays expanded and stays hidden,
 * so reopening the parent restores the subtree as it was.
 */
export function flattenTree(
  listings: ReadonlyMap<string, readonly ProjectEntry[]>,
  expanded: ReadonlySet<string>,
  showHidden: boolean,
): TreeRowData[] {
  const out: TreeRowData[] = [];
  const walk = (dir: string) => {
    const entries = listings.get(dir);
    if (!entries) return;
    for (const row of rowsOf(entries)) {
      if (row.hidden && !showHidden) continue;
      out.push(row);
      if (row.kind === "directory" && expanded.has(row.path)) walk(row.path);
    }
  };
  walk("");
  return out;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

export class ProjectTreeModel {
  readonly root: string;
  private readonly read: DirectoryReader;

  private listings = new Map<string, readonly ProjectEntry[]>();
  private expanded: ReadonlySet<string> = EMPTY_SET;
  private loading: ReadonlySet<string> = EMPTY_SET;
  private errors: ReadonlyMap<string, string> = EMPTY_MAP;
  private showHidden: boolean;

  /** Directories queued for the next batch. */
  private queued = new Set<string>();
  private flushScheduled = false;
  /** Per directory: the promise for its outstanding fetch. */
  private inflight = new Map<string, Promise<void>>();
  /** Waiters for a queued (not yet sent) directory. */
  private waiting = new Map<string, Array<() => void>>();
  /** Per directory: the request generation, so a slow stale answer never
   *  overwrites a fresher one. */
  private generation = new Map<string, number>();
  private nextGeneration = 0;

  private snapshot: TreeSnapshot | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(root: string, read: DirectoryReader, opts: { showHidden?: boolean } = {}) {
    this.root = root;
    this.read = read;
    this.showHidden = opts.showHidden ?? false;
  }

  // ── Subscription ──────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TreeSnapshot => {
    if (!this.snapshot) {
      this.snapshot = {
        rows: flattenTree(this.listings, this.expanded, this.showHidden),
        expanded: this.expanded,
        loading: this.loading,
        errors: this.errors,
        ready: this.listings.has(""),
      };
    }
    return this.snapshot;
  };

  private changed() {
    this.snapshot = null;
    for (const listener of this.listeners) listener();
  }

  /** Stop answering: a model dropped from the cache ignores late responses. */
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  isLoaded(path: string): boolean {
    return this.listings.has(path);
  }

  isExpanded(path: string): boolean {
    return this.expanded.has(path);
  }

  /** The kind of a loaded entry, or `undefined` when its parent is not loaded. */
  kindOf(path: string): ProjectEntryKind | undefined {
    if (path === "") return "directory";
    const siblings = this.listings.get(parentOf(path));
    return siblings?.find((e) => e.path === path)?.kind;
  }

  /** Every loaded directory: what a refresh re-reads. */
  loadedDirectories(): string[] {
    return [...this.listings.keys()];
  }

  // ── Loading ───────────────────────────────────────────────────────────

  /**
   * Fetch `paths` (root-relative directories) in one batched call. Already
   * loaded ones are skipped unless `force`. Resolves when every one of them
   * has answered, failed or been superseded.
   */
  load(paths: readonly string[], opts: { force?: boolean } = {}): Promise<void> {
    const pending: Promise<void>[] = [];
    let addedLoading = false;
    for (const path of paths) {
      if (this.queued.has(path)) {
        pending.push(this.waitFor(path));
        continue;
      }
      const flight = this.inflight.get(path);
      if (flight && !opts.force) {
        pending.push(flight);
        continue;
      }
      if (!opts.force && this.listings.has(path)) continue;
      this.queued.add(path);
      if (!this.listings.has(path) && !this.loading.has(path)) {
        if (!addedLoading) this.loading = new Set(this.loading);
        (this.loading as Set<string>).add(path);
        addedLoading = true;
      }
      pending.push(this.waitFor(path));
    }
    if (addedLoading) this.changed();
    if (this.queued.size > 0 && !this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
    return Promise.all(pending).then(() => undefined);
  }

  private waitFor(path: string): Promise<void> {
    return new Promise((resolve) => {
      const list = this.waiting.get(path);
      if (list) list.push(resolve);
      else this.waiting.set(path, [resolve]);
    });
  }

  private flush() {
    this.flushScheduled = false;
    if (this.disposed) return;
    const paths = [...this.queued];
    this.queued.clear();
    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      const chunk = paths.slice(i, i + BATCH_SIZE);
      const generations = chunk.map((path) => {
        const gen = ++this.nextGeneration;
        this.generation.set(path, gen);
        return gen;
      });
      const request = this.read(this.root, chunk).then(
        (listings) => this.apply(chunk, generations, listings, null),
        (error: unknown) => this.apply(chunk, generations, [], String(error)),
      );
      for (const path of chunk) {
        // Taken now: a waiter that queues the same path again after this
        // point waits for that later request, not this one.
        const waiters = this.waiting.get(path) ?? [];
        this.waiting.delete(path);
        const done = request.then(() => {
          if (this.inflight.get(path) === done) this.inflight.delete(path);
          for (const resolve of waiters) resolve();
        });
        this.inflight.set(path, done);
      }
    }
  }

  private apply(
    paths: string[],
    generations: number[],
    answers: DirectoryListing[],
    failure: string | null,
  ) {
    if (this.disposed) return;
    const byPath = new Map(answers.map((a) => [a.path, a]));
    let loading: Set<string> | null = null;
    let errors: Map<string, string> | null = null;
    let touched = false;
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      if (this.generation.get(path) !== generations[i]) continue; // superseded
      if (this.loading.has(path)) {
        loading ??= new Set(this.loading);
        loading.delete(path);
      }
      const answer = byPath.get(path);
      const error = failure ?? answer?.error ?? (answer ? null : `No listing for ${path || "/"}`);
      if (error) {
        errors ??= new Map(this.errors);
        errors.set(path, error);
        // A folder that vanished takes its subtree with it.
        if (path !== "" && this.listings.has(path)) this.forget(path);
      } else {
        if (this.errors.has(path)) {
          errors ??= new Map(this.errors);
          errors.delete(path);
        }
        this.replaceListing(path, answer!.entries);
      }
      touched = true;
    }
    if (loading) this.loading = loading;
    if (errors) this.errors = errors;
    if (touched) this.changed();
  }

  /** Swap in a fresh listing, dropping cached subdirectories that are gone. */
  private replaceListing(path: string, entries: ProjectEntry[]) {
    const previous = this.listings.get(path);
    if (previous && sameEntries(previous, entries)) return; // keep row identity
    if (previous) {
      const still = new Set<string>();
      for (const e of entries) if (e.kind === "directory") still.add(e.path);
      for (const e of previous) {
        if (e.kind === "directory" && !still.has(e.path)) this.forget(e.path);
      }
    }
    this.listings.set(path, entries);
  }

  /** Drop a directory's listing and everything cached under it. */
  private forget(path: string) {
    const prefix = `${path}/`;
    // Deleting the entry being visited is safe for a Map iterator.
    for (const key of this.listings.keys()) {
      if (key === path || key.startsWith(prefix)) this.listings.delete(key);
    }
    let expanded: Set<string> | null = null;
    for (const key of this.expanded) {
      if (key === path || key.startsWith(prefix)) {
        expanded ??= new Set(this.expanded);
        expanded.delete(key);
      }
    }
    if (expanded) this.expanded = expanded;
  }

  // ── Expansion ─────────────────────────────────────────────────────────

  expand(path: string): Promise<void> {
    return this.setExpanded([path], true);
  }

  collapse(path: string): void {
    void this.setExpanded([path], false);
  }

  toggle(path: string): Promise<void> {
    return this.setExpanded([path], !this.expanded.has(path));
  }

  /** Open or close several directories in one change and one batch. */
  setExpanded(paths: readonly string[], open: boolean): Promise<void> {
    let next: Set<string> | null = null;
    for (const path of paths) {
      if (path === "" || this.expanded.has(path) === open) continue;
      next ??= new Set(this.expanded);
      if (open) next.add(path);
      else next.delete(path);
    }
    if (next) {
      this.expanded = next;
      this.changed();
    }
    return open ? this.load(paths.filter((p) => p !== "")) : Promise.resolve();
  }

  collapseAll(): void {
    if (this.expanded.size === 0) return;
    this.expanded = EMPTY_SET;
    this.changed();
  }

  /**
   * Open every directory, loading as it goes, except ignored ones: an ignored
   * `node_modules` can hold tens of thousands of entries, so it still opens
   * by hand but never by this. Resolves when the walk is done; `signal` stops
   * it between levels.
   */
  async expandAll(signal?: AbortSignal): Promise<void> {
    await this.load([""]);
    let frontier = [""];
    while (frontier.length > 0 && !signal?.aborted && !this.disposed) {
      const dirs: string[] = [];
      for (const dir of frontier) {
        for (const e of this.listings.get(dir) ?? []) {
          if (e.kind !== "directory" || e.ignored) continue;
          if (!this.showHidden && nameOf(e.path).startsWith(".")) continue;
          dirs.push(e.path);
        }
      }
      if (dirs.length === 0) break;
      await this.setExpanded(dirs, true);
      frontier = dirs;
    }
  }

  /**
   * Load and open every folder above `path` so its row is on screen. One
   * batch for the whole chain. Resolves with the row's index, or -1 when the
   * path is not there (deleted, hidden, outside the root).
   */
  async reveal(path: string): Promise<number> {
    if (!path) return -1;
    const ancestors = ancestorsOf(path);
    await this.load(ancestors);
    if (this.disposed) return -1;
    await this.setExpanded(ancestors, true);
    return this.indexOf(path);
  }

  indexOf(path: string): number {
    return this.getSnapshot().rows.findIndex((r) => r.path === path);
  }

  // ── Refresh ───────────────────────────────────────────────────────────

  /**
   * Re-read directories after a change on disk. With `dirs`, only those that
   * are loaded (a watcher reports every folder it saw touched, most of them
   * never opened here); without, everything loaded. Expansion survives.
   */
  refresh(dirs?: readonly string[]): Promise<void> {
    // A folder that failed is retried too: it may have been created since.
    const known = (d: string) => this.listings.has(d) || this.errors.has(d);
    const targets = dirs
      ? dirs.filter(known)
      : [
          ...this.loadedDirectories(),
          ...[...this.errors.keys()].filter((d) => !this.listings.has(d)),
        ];
    if (!this.listings.has("") && (!dirs || dirs.includes(""))) targets.push("");
    return this.load(targets, { force: true });
  }

  setShowHidden(show: boolean): void {
    if (show === this.showHidden) return;
    this.showHidden = show;
    this.changed();
  }
}

function sameEntries(a: readonly ProjectEntry[], b: readonly ProjectEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.path !== y.path || x.kind !== y.kind || (x.ignored ?? false) !== (y.ignored ?? false)) {
      return false;
    }
  }
  return true;
}

// ── One model per project root ──────────────────────────────────────────

const models = new Map<string, ProjectTreeModel>();

/** The model for `root`, created on first ask and kept for the run. */
export function projectTreeModel(
  root: string,
  read: DirectoryReader,
  opts: { showHidden?: boolean } = {},
): ProjectTreeModel {
  let model = models.get(root);
  if (!model) {
    model = new ProjectTreeModel(root, read, opts);
    models.set(root, model);
  }
  return model;
}

/** Drop a root's model (tests; a project closed for good). */
export function dropProjectTreeModel(root: string): void {
  models.get(root)?.dispose();
  models.delete(root);
}

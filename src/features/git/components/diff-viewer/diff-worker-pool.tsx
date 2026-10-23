import { WorkerPoolContext, useWorkerPool } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { DIFF_THEME_NAME, ensureDiffTheme } from "../../lib/diff-theme";

/**
 * The Shiki workers every diff viewer tokenizes in. The main thread never
 * tokenizes: a viewer renders nothing until its pool is up, rather than fall
 * back to highlighting in the UI's own frame budget.
 *
 * One pool for the window, shared by every mounted viewer and kept for a while
 * after the last one goes, so closing and reopening the diff does not pay for
 * new workers and a cold grammar cache.
 */

/** Oniguruma in WASM. Shiki's JS regex engine can backtrack catastrophically
 *  on a hostile line and wedge a worker; the WASM engine cannot. */
export const PREFERRED_HIGHLIGHTER = "shiki-wasm" as const;

const IDLE_TTL_MS = 30_000;

/** Half the cores, 2–6: enough to tokenize a long diff in parallel without
 *  starving the agent's own work or the UI. */
function poolSize(): number {
  const cores =
    typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
  return Math.max(2, Math.min(6, Math.floor(cores / 2)));
}

interface SharedPool {
  readonly pool: WorkerPoolManager;
  consumers: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

let shared: SharedPool | undefined;

function acquire(): SharedPool {
  if (!shared) {
    ensureDiffTheme();
    shared = {
      pool: new WorkerPoolManager(
        {
          workerFactory: () => new DiffsWorker(),
          poolSize: poolSize(),
          totalASTLRUCacheSize: 240,
        },
        {
          // A theme of theme-variable references (`diff-theme.ts`): a theme
          // switch recolours the cached tokens, so the pool never re-themes.
          theme: DIFF_THEME_NAME,
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          // A minified bundle's one 400 KB line would hold a worker for
          // seconds; past this length a line is shown plain.
          tokenizeMaxLineLength: 1_000,
          useTokenTransformer: true,
        },
      ),
      consumers: 0,
      idleTimer: undefined,
    };
  }
  const entry = shared;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  entry.consumers += 1;
  return entry;
}

function release(entry: SharedPool): void {
  entry.consumers -= 1;
  if (entry.consumers !== 0) return;
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = undefined;
    entry.pool.terminate();
    if (shared === entry) shared = undefined;
  }, IDLE_TTL_MS);
}

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const entry = acquire();
  onStoreChange();
  return () => release(entry);
}

const getPool = () => shared?.pool;
const getServerPool = () => undefined;

/** Children mount once the workers are up, so a first paint is never
 *  highlighted on the main thread. */
function PoolReady({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const pool = useWorkerPool();
  const [readyPool, setReadyPool] = useState<WorkerPoolManager>();
  const ready = pool ? readyPool === pool || pool.isInitialized() || !pool.isWorkingPool() : false;

  useEffect(() => {
    if (ready || !pool) return;
    let mounted = true;
    const finish = () => {
      if (mounted) setReadyPool(pool);
    };
    void pool.initialize().then(finish, finish);
    return () => {
      mounted = false;
    };
  }, [ready, pool]);

  return ready ? children : fallback;
}

export function DiffWorkerPoolProvider({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  // Stable identity: a new one would make React release and re-acquire the
  // shared pool on every render.
  const stableSubscribe = useCallback(subscribe, []);
  const pool = useSyncExternalStore(stableSubscribe, getPool, getServerPool);
  return (
    <WorkerPoolContext value={pool}>
      <PoolReady fallback={fallback}>{children}</PoolReady>
    </WorkerPoolContext>
  );
}

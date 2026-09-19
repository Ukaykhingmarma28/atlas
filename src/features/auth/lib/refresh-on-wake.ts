/**
 * Re-pull the account snapshot (identity + organisation list) when the window
 * comes back to the foreground.
 *
 * Rust refreshes the snapshot only at launch and on the switcher's manual
 * refresh icon. Anything changed on the web while Atlas sat in the background —
 * an organisation renamed, a member added — therefore stayed stale until the
 * next relaunch. Waking is the moment the user is about to look at the list,
 * and it is how the web session itself catches up, so it is the trigger here.
 *
 * Throttled: the auth worker's budget is 100 requests / 60 s and a refresh
 * costs a few (`core.rs` `fetch_orgs` doc), and macOS Space switches can fire
 * several focus edges in a row. Failures are swallowed on purpose — Rust keeps
 * the last-known list, and a toast for a background pull would be noise.
 */
export interface WakeRefresherOptions {
  /** The pull. Typically `auth.refresh`. */
  refresh: () => Promise<unknown>;
  /** Gate: only a signed-in account has anything to re-pull. */
  isSignedIn: () => boolean;
  /** Minimum gap between two pulls. */
  minIntervalMs: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export function createWakeRefresher(opts: WakeRefresherOptions): () => void {
  const now = opts.now ?? Date.now;
  // Seeded at creation: launch has just validated (and pulled) the snapshot,
  // so a focus edge in the first minutes has nothing newer to fetch.
  let lastPullAt = now();
  return () => {
    if (!opts.isSignedIn()) return;
    const t = now();
    if (t - lastPullAt < opts.minIntervalMs) return;
    lastPullAt = t;
    void opts.refresh().catch(() => {});
  };
}

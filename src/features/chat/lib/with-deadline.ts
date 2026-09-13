/**
 * A client-side deadline on an IPC hop that may never settle.
 *
 * The bind path (`agents_spawn`, `agents_new_session`) awaits Rust futures
 * that, before PR 2 of the stalled-start plan, had no timeout of their own: an
 * `npm install` against a black-hole registry, or a `session/new` into a
 * wedged app-server, simply never answered. An `await` with no deadline left
 * the panel's `pending` flag set for the life of the app, which silently
 * disabled every retry path (focus, sign-in, silent) — the "Starting Codex"
 * that never ends. This makes the hop REJECT instead, so the ordinary failure
 * path runs: the held message goes back to the queue chip, the status drops to
 * idle, the failure is logged and reported.
 *
 * Rejection only — the underlying promise is not cancelled (a JS promise
 * cannot be). Callers that need the backend to give up too kill the plugin.
 */

export const BIND_TIMEOUT_CODE = "bind-timeout" as const;

export class DeadlineError extends Error {
  readonly code = BIND_TIMEOUT_CODE;
  /** Structured `kind` so `errInfo` reads it like a backend rejection. */
  readonly kind = "timeout";
  constructor(message: string) {
    super(message);
    this.name = "DeadlineError";
  }
}

/** True when `err` is a deadline expiry from [`withDeadline`]. */
export function isDeadlineError(err: unknown): err is DeadlineError {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === BIND_TIMEOUT_CODE;
}

/** Human-readable duration for the error text: "3 minutes", "90 seconds". */
export function describeMs(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const m = ms / 60_000;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const s = Math.round(ms / 1000);
  return `${s} second${s === 1 ? "" : "s"}`;
}

/**
 * Await `promise`, but reject with a [`DeadlineError`] after `ms`.
 *
 * `label` names the hop for the error text — "Codex has not answered
 * `session/new` in 3 minutes" — so the report says WHICH step hung. The timer
 * is cleared as soon as the promise settles either way, so a fast hop leaves
 * nothing behind.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DeadlineError(`${label} in ${describeMs(ms)}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

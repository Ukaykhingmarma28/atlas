/**
 * The realtime subscription, one call at a time.
 *
 * `artifacts_cloud_watch` is issued from a React effect: subscribe on mount,
 * unsubscribe on cleanup. Tauri runs each invoke on its own task, so two
 * issued back to back can land in either order — and under StrictMode a mount
 * is `subscribe, unsubscribe, subscribe`. Landing as `subscribe, subscribe,
 * unsubscribe` left the Session silently unsubscribed with no effect left to
 * run: comments stopped until the pane was reopened.
 *
 * So every watch goes through one promise chain, in the order it was asked.
 * A failed call is dropped, not propagated: a chain that stayed rejected
 * would refuse every subscribe after the first Project without a socket.
 */

import { invoke } from "@tauri-apps/api/core";

let chain: Promise<void> = Promise.resolve();

export function queueWatch(projectId: string, sessionId: string | null): Promise<void> {
  chain = chain
    .then(() => invoke("artifacts_cloud_watch", { projectId, sessionId }))
    .then(
      () => undefined,
      () => undefined,
    );
  return chain;
}

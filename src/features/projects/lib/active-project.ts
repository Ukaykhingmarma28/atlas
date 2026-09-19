import { useProjectStore } from "../stores/project-store";

/**
 * The id of the currently-active project, or `null` if none is open.
 *
 * This is the key that replaced `webview.label()` for all per-project Rust
 * state (file index, git watcher, mention cache, recent files). Every IPC call
 * that targets project-scoped state should thread this through as
 * `projectId` so the right project's resident state is hit — multiple
 * projects now share a single window/webview label.
 */
export function activeProjectId(): string | null {
  return useProjectStore.getState().activeProjectId;
}

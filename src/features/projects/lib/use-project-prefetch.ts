import { useEffect } from "react";
import { useProjectGitStore } from "../stores/project-git-store";
import { useActiveOrgProjects } from "./org-scope";

/**
 * Warm the project-pane data at startup so the first sidebar slide is smooth.
 *
 * The only IPC-backed data the pane needs is each project's git summary
 * (`git_workspace_summary`). Lazily fetching those when the sidebar first gains
 * size dropped a frame mid-animation (the async result re-rendered the rows).
 * Here we prefetch ALL projects' summaries into the module-level cache
 * (`project-git-store`) on an idle callback right after boot, so by the time
 * the user opens the pane the rows render straight from cache. The git store
 * dedups (won't refetch) and already refreshes in the background on
 * `atlas:git-changed`, so this is idempotent and cheap on re-runs.
 */
export function useProjectGitPrefetch() {
  // Only the ACTIVE org's projects — prefetching every org's paths warmed
  // caches for projects the current org never renders. Re-runs only when the
  // SET of paths changes (the signature string is stable otherwise), which
  // includes an org switch: the incoming org's summaries warm automatically.
  const projects = useActiveOrgProjects();
  const pathsSig = projects.map((w) => w.path).join("\n");

  useEffect(() => {
    if (!pathsSig) return;
    const run = () => {
      const ensure = useProjectGitStore.getState().actions.ensure;
      for (const p of pathsSig.split("\n")) if (p) ensure(p);
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 1500 });
      return () => window.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(run, 200);
    return () => window.clearTimeout(id);
  }, [pathsSig]);
}

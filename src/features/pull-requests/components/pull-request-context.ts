import { createContext, useContext } from "react";

/** Which pull request the components below are drawing: the checkout `gh`
 *  runs in (images are proxied through it too), the number, and the
 *  repository's web address for autolinks. */
export interface PullRequestScope {
  repoPath: string;
  number: number;
  repositoryUrl: string | null;
}

export const PullRequestScopeContext = createContext<PullRequestScope | null>(null);

export function usePullRequestScope(): PullRequestScope {
  const scope = useContext(PullRequestScopeContext);
  if (!scope) throw new Error("usePullRequestScope outside a pull request");
  return scope;
}

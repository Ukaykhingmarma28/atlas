// Opening a session's linked pull request (the sidebar badge and hover
// card). A link names its own repository, and the tab reads by number in the
// session's checkout, so a link from another repository (an agent may link
// any pull request) opened as `cwd + number` would show an unrelated pull
// request. Only a link to the checkout's own repository opens a tab; any
// other, or one whose checkout cannot be read, opens on the host.

import { openPullRequest } from "@/features/git/lib/git-pr-api";

import { openPullRequestTab } from "./open-pull-request-tab";
import { prProvider } from "./pull-requests-api";
import type { PrProvider } from "./pull-requests-types";

export interface OpenableLink {
  /** `owner/name`. */
  repository: string;
  number: number;
  url: string;
  title?: string | null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Whether `link` is a pull request of the checkout `provider` describes. */
export function linkBelongsToCheckout(
  link: Pick<OpenableLink, "repository" | "url">,
  provider: Pick<PrProvider, "host" | "repository">,
): boolean {
  if (link.repository.toLowerCase() !== provider.repository.toLowerCase()) return false;
  const host = hostOf(link.url);
  return host === null || host === provider.host.toLowerCase().replace(/^www\./, "");
}

export async function openLinkedPullRequest(cwd: string, link: OpenableLink): Promise<void> {
  const provider = await prProvider(cwd).catch(() => null);
  if (provider && linkBelongsToCheckout(link, provider)) {
    openPullRequestTab({
      repoPath: cwd,
      number: link.number,
      title: link.title ?? `#${link.number}`,
    });
  } else {
    openPullRequest(link.url);
  }
}

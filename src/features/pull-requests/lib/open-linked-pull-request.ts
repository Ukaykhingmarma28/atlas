// Opening a pull request link: a session's linked pull request (the sidebar
// badge and hover card), and a pull request URL clicked in a transcript
// (`markdown-links.ts`). A link names its own repository, and the tab reads
// by number in the session's checkout, so a link from another repository (an
// agent may link any pull request) opened as `cwd + number` would show an
// unrelated pull request. Only a link to the checkout's own repository opens
// a tab; any other, or one whose checkout cannot be read, opens on the host.
// So does every link while `pullRequestLinksOpenInApp` is off, and a link the
// reader asked to open on the host (a modifier-click).

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { useSettingsStore } from "@/features/settings/stores/settings-store";

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

/** `https://host/owner/name/pull/42`, with anything after the number. */
const PULL_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/** A pull request URL as a link, or `null` for any other address. */
export function parsePullRequestUrl(href: string): OpenableLink | null {
  const url = href.trim();
  const match = PULL_URL.exec(url);
  if (!match) return null;
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { repository: `${match[2]}/${match[3]}`, number, url };
}

/** Whether pull request links open in a tab at all (the setting). */
export function pullRequestLinksOpenInApp(): boolean {
  return useSettingsStore.getState().settings.pullRequestLinksOpenInApp;
}

/**
 * Open `link`: as a tab in `cwd`'s checkout when it is that checkout's pull
 * request and the setting allows, else on the host. `external` (a
 * modifier-click) and a `null` checkout always open on the host.
 */
export async function openLinkedPullRequest(
  cwd: string | null,
  link: OpenableLink,
  opts: { external?: boolean } = {},
): Promise<void> {
  if (opts.external || cwd === null || !pullRequestLinksOpenInApp()) {
    openPullRequest(link.url);
    return;
  }
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

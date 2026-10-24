// Which service a web link in a session points at, and the short label a bare
// link of it reads as. `markdown-render.ts` asks this once per anchor while it
// renders a message, and draws the service's icon before the link's text
// (`.atlas-link__icon`, painted from `src/assets/link-services/`).
//
//   https://github.com/acme/web/pull/42                     → github  "PR #42"
//   https://github.com/acme/web/issues/17                   → github  "#17"
//   https://github.com/acme/web/commit/3f9c2d1e8b…          → github  "3f9c2d1" (monospace)
//   https://github.com/acme/web                             → github  "acme/web"
//   https://linear.app/atlas/issue/ATL-978/browser-goes-…   → linear  "ATL-978"
//   https://example.com/docs                                → web     (the globe, no label)
//
// Only a link written bare (its text is its address) is shortened: a link
// with words of its own keeps them. The full address stays in the tooltip, and
// a copy of the message carries it (`markdown-links.ts`).
//
// Pure and dependency-free: it runs inside the markdown worker too, and on
// every tick of the streaming tail, so the work is one `URL` parse and a few
// anchored regexes per link, and none for anything that is not http(s).

/** A service with a bundled icon, or `web` for any other http(s) address. */
export type LinkService =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "forgejo"
  | "linear"
  | "slack"
  | "notion"
  | "figma"
  | "vercel"
  | "npm"
  | "web";

export interface LinkFacts {
  service: LinkService;
  /** What a bare link reads as, or null to keep its address. */
  short: string | null;
  /** The short label is a commit hash, set in the monospace face. */
  commit: boolean;
}

/** The URL behind an http(s) link, or null for anything else. */
export function resolveExternalWebLink(href: string | null | undefined): URL | null {
  if (!href) return null;
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/** `hostname` is `apex` or a subdomain of it, or (given one) carries `label` as
 *  one of its parts, which is how a self-hosted install is usually named
 *  (`github.acme.com`, `gitlab.internal.dev`). */
function isHostOf(hostname: string, apex: string, label?: string): boolean {
  if (hostname === apex || hostname.endsWith(`.${apex}`)) return true;
  return label !== undefined && hostname.split(".").includes(label);
}

/** The service a hostname belongs to. */
export function linkServiceOfHost(hostname: string): LinkService {
  const host = hostname.toLowerCase();
  if (isHostOf(host, "github.com", "github") || isHostOf(host, "githubusercontent.com")) {
    return "github";
  }
  if (isHostOf(host, "gitlab.com", "gitlab")) return "gitlab";
  if (isHostOf(host, "bitbucket.org", "bitbucket")) return "bitbucket";
  if (isHostOf(host, "codeberg.org", "forgejo")) return "forgejo";
  if (isHostOf(host, "linear.app")) return "linear";
  if (isHostOf(host, "slack.com")) return "slack";
  if (isHostOf(host, "notion.so") || isHostOf(host, "notion.site")) return "notion";
  if (isHostOf(host, "figma.com")) return "figma";
  if (isHostOf(host, "vercel.com") || isHostOf(host, "vercel.app")) return "vercel";
  if (isHostOf(host, "npmjs.com")) return "npm";
  return "web";
}

// ── Change requests ───────────────────────────────────────────────────────────

/** A pull request (or merge request) on a forge: the repository path below
 *  the host, lower case, and its number. */
export interface ChangeRequestLink {
  host: string;
  repository: string;
  number: number;
}

function claim(host: string, match: RegExpExecArray | null): ChangeRequestLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}

/** The pull request a URL names on GitHub, GitLab, Bitbucket, Forgejo/Gitea
 *  or Azure DevOps, or null. Each forge is told apart by its own route, so a
 *  self-hosted install on any hostname is read too. */
export function parseChangeRequestUrl(target: string | URL): ChangeRequestLink | null {
  const url = typeof target === "string" ? resolveExternalWebLink(target) : target;
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (isHostOf(host, "github.com", "github")) {
    const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (match) return claim(host, match);
  }
  const forgejo = /^\/([^/]+(?:\/[^/]+)+)\/pulls\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (forgejo) return claim(host, forgejo);
  const gitlab = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (gitlab) return claim(host, gitlab);
  if (isHostOf(host, "bitbucket.org", "bitbucket")) {
    const match = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (match) return claim(host, match);
  }
  // Azure DevOps Server can use any hostname; its `_git` pull request route identifies it.
  const azure = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u.exec(url.pathname);
  return claim(host, azure);
}

// ── Short labels ──────────────────────────────────────────────────────────────

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` when both are a valid GitHub owner and repository name. */
function repositoryOf(owner: string, name: string): string | null {
  const trimmedName = name.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !NAME.test(trimmedName) || /^\.+$/.test(trimmedName)) return null;
  return `${owner}/${trimmedName}`;
}

/** Top-level GitHub paths that are pages of the site, not an owner. */
const GITHUB_RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "collections",
  "enterprise",
  "explore",
  "features",
  "login",
  "marketplace",
  "notifications",
  "orgs",
  "pricing",
  "pulls",
  "issues",
  "search",
  "settings",
  "sponsors",
  "topics",
  "trending",
]);

function githubShort(url: URL): Pick<LinkFacts, "short" | "commit"> | null {
  const pull = parseChangeRequestUrl(url);
  if (pull) return { short: `PR #${pull.number}`, commit: false };
  const issue = /^\/[^/]+\/[^/]+\/issues\/([1-9]\d*)\/?$/u.exec(url.pathname);
  if (issue) return { short: `#${issue[1]}`, commit: false };
  const commit = /^\/[^/]+\/[^/]+\/commit\/([0-9a-f]{7,40})\/?$/iu.exec(url.pathname);
  if (commit) return { short: commit[1].slice(0, 7), commit: true };
  if (
    url.hostname.toLowerCase() !== "github.com" &&
    url.hostname.toLowerCase() !== "www.github.com"
  )
    return null;
  const repo = /^\/([^/]+)\/([^/]+)\/?$/u.exec(url.pathname);
  if (repo && !GITHUB_RESERVED_OWNERS.has(repo[1].toLowerCase()) && !url.search && !url.hash) {
    const name = repositoryOf(repo[1], repo[2]);
    if (name) return { short: name, commit: false };
  }
  return null;
}

/** `ATL-978` from `/atlas/issue/ATL-978/browser-goes-agent-driven`. */
const LINEAR_ISSUE = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-[1-9]\d*)(?:\/|$)/u;

function shortLabel(service: LinkService, url: URL): Pick<LinkFacts, "short" | "commit"> {
  const none = { short: null, commit: false };
  switch (service) {
    case "github":
      return githubShort(url) ?? none;
    case "linear": {
      const issue = LINEAR_ISSUE.exec(url.pathname);
      return issue ? { short: issue[1].toUpperCase(), commit: false } : none;
    }
    default: {
      // Any forge's pull request reads the same, wherever it is hosted.
      const pull = parseChangeRequestUrl(url);
      if (pull) return { short: `PR #${pull.number}`, commit: false };
      const gitlabIssue = /^\/[^/]+(?:\/[^/]+)+\/-\/issues\/([1-9]\d*)\/?$/u.exec(url.pathname);
      return service === "gitlab" && gitlabIssue
        ? { short: `#${gitlabIssue[1]}`, commit: false }
        : none;
    }
  }
}

/** The service and short label for a link, or null when it is not http(s). */
export function linkFacts(href: string): LinkFacts | null {
  if (!/^(?:https?:)?\/\//i.test(href)) return null;
  const url = resolveExternalWebLink(href);
  if (!url || !url.hostname) return null;
  const service = linkServiceOfHost(url.hostname);
  return { service, ...shortLabel(service, url) };
}

/** Whether a link's text is just its address: a bare URL, or `[url](url)`.
 *  GFM writes `www.x.com` as `http://www.x.com`, and a trailing slash is the
 *  same page either way. */
export function textIsAddress(text: string, href: string): boolean {
  const clean = (s: string) =>
    s
      .trim()
      .replace(/^(?:https?:)?\/\//i, "")
      .replace(/\/+$/, "");
  const t = clean(text);
  return t.length > 0 && t === clean(href);
}

/** How many leading characters of a link's text stay on the icon's line, so a
 *  wrap never leaves the icon alone at the end of one: the whole `https://`,
 *  or the first character. */
export function leadingLinkTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  return Math.min(text.length, 1);
}

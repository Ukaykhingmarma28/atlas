/**
 * What the "Link a pull request" box was given: a pull request URL, or a
 * number (`42`, `#42`) in the session's repository. Pure, for the test.
 *
 * A URL must name the checkout's own repository, host included: the link is
 * recorded against the session's checkout by number, so a URL from anywhere
 * else would link whatever pull request has that number here. Until the
 * checkout's repository is known, no URL is taken at all (`waiting`).
 */

export type LinkInput =
  | { kind: "empty" }
  | { kind: "ok"; number: number }
  /** A URL, while the session's repository is still being read. */
  | { kind: "waiting"; message: string }
  | { kind: "error"; message: string };

/** The checkout's repository as the provider reports it. */
export interface LinkRepository {
  /** `github.com`, or an Enterprise host. */
  host: string;
  /** `owner/name`. */
  repository: string;
}

const NUMBER = /^#?(\d+)$/;
/** `https://host/owner/name/pull/42`, with anything after the number. */
const PULL_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pulls?\/(\d+)(?:[/?#].*)?$/i;

/** A host as written in a URL, compared without case, port or `www.`. */
function normalHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
}

/** `repository` is the checkout's, `null` until it is known. */
export function resolveLinkInput(reference: string, repository: LinkRepository | null): LinkInput {
  const text = reference.trim();
  if (!text) return { kind: "empty" };
  const number = NUMBER.exec(text);
  if (number) {
    const n = Number(number[1]);
    return Number.isSafeInteger(n) && n > 0
      ? { kind: "ok", number: n }
      : { kind: "error", message: "Use a pull request number above 0." };
  }
  const url = PULL_URL.exec(text);
  if (!url) return { kind: "error", message: "Use a pull request URL or number, like 42 or #42." };
  const n = Number(url[4]);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { kind: "error", message: "That URL names no pull request." };
  }
  if (!repository) {
    return {
      kind: "waiting",
      message: "Reading this session's repository; a URL can be linked once it is known.",
    };
  }
  const [owner, name] = repository.repository.split("/");
  const sameHost = normalHost(url[1]!) === normalHost(repository.host);
  const sameRepo =
    url[2]!.toLowerCase() === owner?.toLowerCase() && url[3]!.toLowerCase() === name?.toLowerCase();
  if (!sameHost || !sameRepo) {
    const named = sameHost ? `${url[2]}/${url[3]}` : `${url[1]}/${url[2]}/${url[3]}`;
    const here = sameHost ? repository.repository : `${repository.host}/${repository.repository}`;
    return {
      kind: "error",
      message: `That pull request is in ${named}; this session's repository is ${here}.`,
    };
  }
  return { kind: "ok", number: n };
}

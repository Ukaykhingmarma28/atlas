/**
 * What the "Link a pull request" box was given: a pull request URL, or a
 * number (`42`, `#42`) in the session's repository. Pure, for the test.
 *
 * A URL must name the checkout's own repository: the link is recorded against
 * the session's checkout, and a pull request elsewhere could not be read
 * through it.
 */

export type LinkInput =
  | { kind: "empty" }
  | { kind: "ok"; number: number }
  | { kind: "error"; message: string };

const NUMBER = /^#?(\d+)$/;
/** `https://host/owner/name/pull/42`, with anything after the number. */
const PULL_URL = /^https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pulls?\/(\d+)(?:[/?#].*)?$/i;

/** `repository` is the checkout's `owner/name`, `null` until it is known. */
export function resolveLinkInput(reference: string, repository: string | null): LinkInput {
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
  const n = Number(url[2]);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { kind: "error", message: "That URL names no pull request." };
  }
  if (repository && url[1]!.toLowerCase() !== repository.toLowerCase()) {
    return {
      kind: "error",
      message: `That pull request is in ${url[1]}; this session's repository is ${repository}.`,
    };
  }
  return { kind: "ok", number: n };
}

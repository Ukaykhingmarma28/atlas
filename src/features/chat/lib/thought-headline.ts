/**
 * The one line a thinking block shows while collapsed: what the agent is
 * thinking about right now, not just that it is thinking.
 *
 * Reasoning streams as markdown, often as a run of short sections that each
 * open with a bold heading ("**Checking the cache key**"). The newest section
 * is the current thought, so this reads the last heading on a line of its
 * own. Reasoning with no headings gives the first sentence of its last
 * paragraph instead. Inline markdown is stripped. Null when there is nothing
 * worth showing yet.
 *
 * It runs on the live thought every streaming frame, so it only ever strips
 * a bounded slice of text, and its patterns stay linear.
 */
export function thoughtHeadline(markdown: string): string | null {
  const headings = [...markdown.matchAll(/^[ \t]*\*\*([^*\r\n]+)\*\*[ \t]*$/gm)];
  if (headings.length > 0) {
    const heading = clean(headings[headings.length - 1][1].slice(0, MAX_SCAN));
    if (heading) return heading;
  }

  const paragraphs = markdown.split(/\r?\n\s*\r?\n/);
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const paragraph = paragraphs[i].trim();
    // A code block says nothing a reader can follow in one line.
    if (!paragraph || /^(```|~~~)/.test(paragraph)) continue;
    const text = clean(paragraph.slice(0, MAX_SCAN));
    const end = SENTENCE_END.exec(text);
    // A paragraph just begun ("I") would replace a whole thought with a
    // fragment that then regrows a letter per chunk. Keep the previous
    // paragraph's line until this one has said something.
    if (!end && text.length < MIN_UNFINISHED && i > 0) continue;
    // `**` as a thought's first chunk cleans to nothing: no line yet.
    if (!text) continue;
    return end ? text.slice(0, end.index + end[0].length) : text;
  }
  return null;
}

/** How much of a paragraph is ever stripped: well past one line, and short
 *  enough that a 20k-character thought costs the same as a short one. */
const MAX_SCAN = 400;
const MIN_UNFINISHED = 24;
/** A sentence ends at `.`, `?` or `!` (and any closing quote or bracket)
 *  followed by space and something that is not a lowercase letter, so "e.g.
 *  the file" is not two sentences. */
const SENTENCE_END = /[.?!]["'”’)]?(?=\s+[^a-z\s]|\s*$)/;

function clean(text: string): string {
  return text
    .replace(/!?\[([^\][\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

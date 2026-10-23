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
 */
export function thoughtHeadline(markdown: string): string | null {
  const headings = [...markdown.matchAll(/^[ \t]*\*\*([^*\r\n]+)\*\*[ \t]*$/gm)];
  if (headings.length > 0) return headlineOf(`**${headings[headings.length - 1][1]}**`);
  const paragraphs = markdown.split(/\r?\n\s*\r?\n/);
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const line = headlineOf(paragraphs[i]);
    if (line) return line;
  }
  return null;
}

function headlineOf(paragraph: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*(?:\r?\n|$)/.exec(paragraph)?.[1];
  const text = (heading ?? paragraph)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}

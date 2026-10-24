// The renderer half of `pull-request-markdown.tsx`, reached only through its
// `lazy()` boundary so the remark/rehype stack stays out of the tab's first
// chunk.
//
// A pull request's body is GitHub-flavoured markdown with raw HTML in it
// (`<details>`, `<img width=…>`, `<picture>`), written by anyone who can
// open one. So: raw HTML is parsed (`rehype-raw`), then sanitised to GitHub's
// own allowlist (`rehype-sanitize`) before anything is highlighted or drawn.
// Images go through the `gh` image proxy, since the webview may load none
// from the network; links open in the system browser.

import { memo, useMemo, type ComponentProps } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ExternalLink, ImageOff, Paperclip } from "lucide-react";
import "@/styles/hljs.css";

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { cn } from "@/lib/utils";

import { usePrImage } from "../lib/pr-image";
import { remarkPullRequestAutolinks, splitPullRequestBody } from "../lib/pull-request-markdown";
import { usePullRequestScope } from "./pull-request-context";

/** GitHub's allowlist, plus the `<picture>`/`<source>` pair its dark-mode
 *  screenshots use and the sizing attributes images carry. */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "picture", "source"],
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height", "align"],
    source: ["srcSet", "media"],
  },
};

function ProxiedImage({ src, alt, width, height }: ComponentProps<"img">) {
  const { repoPath } = usePullRequestScope();
  const address = typeof src === "string" ? src : null;
  const objectUrl = usePrImage(repoPath, address);
  if (!address) return null;
  if (!objectUrl) {
    return (
      <button
        type="button"
        onClick={() => openPullRequest(address)}
        className="inline-flex max-w-full items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-element-hover hover:text-foreground"
      >
        <ImageOff aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{alt || "Image"}</span>
      </button>
    );
  }
  return (
    <img
      src={objectUrl}
      alt={alt ?? ""}
      width={width}
      height={height}
      className="my-1 inline-block h-auto max-w-full rounded align-middle"
    />
  );
}

// Headings, lists, code, tables and links take `.prose-chat`, the house
// markdown style (links in the info hue, a dotted underline on hover), so a
// pull request reads like every other piece of markdown in the app. Only
// what that stylesheet cannot do is overridden here.
const COMPONENTS: Components = {
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          if (href) openPullRequest(href);
        }}
      >
        {children}
      </a>
    );
  },
  img: ProxiedImage,
  // A `<source>` inside `<picture>` names an image the proxy would have to
  // fetch too; the `<img>` fallback beside it is enough.
  source: () => null,
  details: ({ children }) => <details className="my-2">{children}</details>,
  summary: ({ children }) => (
    <summary className="cursor-pointer text-secondary-foreground hover:text-foreground">
      {children}
    </summary>
  ),
  input: (props) => (
    // Task-list boxes: GitHub ticks them by editing the body, so here they only read.
    <input type="checkbox" checked={props.checked} readOnly disabled />
  ),
};

const REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
  rehypeHighlight,
];

function AttachmentLink({ url }: { url: string }) {
  return (
    <button
      type="button"
      onClick={() => openPullRequest(url)}
      className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left text-xs hover:bg-element-hover"
    >
      <Paperclip aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">Open attachment on GitHub</span>
      <ExternalLink aria-hidden className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

export default memo(function PullRequestMarkdownImpl({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const { repositoryUrl } = usePullRequestScope();
  const remarkPlugins = useMemo<NonNullable<Options["remarkPlugins"]>>(
    () =>
      repositoryUrl ? [remarkGfm, [remarkPullRequestAutolinks, { repositoryUrl }]] : [remarkGfm],
    [repositoryUrl],
  );
  // Parsed and drawn once per text and repository: the scope above changes
  // for reasons of its own (an agent action starting), and every block on
  // the page would otherwise re-run the whole remark/rehype pipeline. The
  // same element tree back lets React skip the subtree.
  return useMemo(
    () => (
      <div
        className={cn(
          "prose-chat min-w-0 text-sm leading-relaxed break-words text-foreground select-text",
          className,
        )}
      >
        {splitPullRequestBody(text).map((segment) =>
          segment.kind === "markdown" || segment.media === "image" ? (
            <ReactMarkdown
              key={segment.id}
              remarkPlugins={remarkPlugins}
              rehypePlugins={REHYPE_PLUGINS}
              components={COMPONENTS}
            >
              {segment.kind === "markdown" ? segment.text : `![](<${segment.url}>)`}
            </ReactMarkdown>
          ) : (
            <AttachmentLink key={segment.id} url={segment.url} />
          ),
        )}
      </div>
    ),
    [text, className, remarkPlugins],
  );
});

// Which inline code and link destinations in a session's markdown name a file
// in its project.
//
// Pure and dependency-free: it runs inside the markdown worker
// (`markdown-render.ts`), once per rendered message string, and never touches
// the filesystem. The test is the shape of the text alone, then whether the
// path lands inside the project root. Whether the file EXISTS is a question
// for the click (`open-path-link.ts`), which asks the file index.
//
// POSIX paths only. A Windows project root still works for relative paths,
// which are what agents write almost all of the time.

/** A file a chip points at. */
export interface FileLinkTarget {
  /** Absolute, normalised: no `.` or `..` segments, no trailing slash. */
  path: string;
  /** 1-based, when the text named one (`a.ts:12`, `a.ts#L12`). */
  line?: number;
  column?: number;
  /** The text named a folder (a link destination ending in `/`). */
  folder: boolean;
}

/** `:12` or `:12:4` at the end. */
const POSITION_SUFFIX = /:(\d+)(?::(\d+))?$/;
/** `#L12` or `#L12C4` at the end. */
const POSITION_HASH = /#L(\d+)(?:C(\d+))?$/i;

/** A relative path that a person would write: dotted or bare segments. */
const RELATIVE_PREFIX = /^(?:\.{1,2}\/)/;
const FILE_EXTENSION = /\.[A-Za-z0-9_-]+$/;
/** `v1.2.3`, `react-19.0.1`: a version, not an extension. */
const VERSION_SUFFIX = /\d\.\d[^.]*$/;
const NUMERIC_DOTTED = /^\d+(?:\.\d+)+$/;
/** Glob and shell metacharacters: `src/**\/*.ts` is a pattern, not a file. */
const GLOB_CHARS = /[*?[\]{}<>|"'$]/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const OTHER_SCHEME = /^(?:mailto|javascript|data|tel):/i;

/** Names that are files with no extension. */
const EXTENSIONLESS_FILES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Caddyfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Podfile",
  "BUILD",
  "WORKSPACE",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CHANGELOG",
  "README",
  "CODEOWNERS",
]);

/** Top-level domains a leading segment would end in if it were a host
 *  (`github.com/x/y.ts`, `example.co.uk/a.js`). */
const HOST_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "ai",
  "co",
  "edu",
  "gov",
  "info",
  "me",
  "sh",
  "xyz",
  "uk",
  "de",
  "fr",
  "jp",
  "cn",
  "us",
  "ca",
  "au",
  "eu",
]);

function looksLikeHost(segment: string): boolean {
  if (segment.startsWith(".")) return false;
  if (segment === "localhost" || NUMERIC_DOTTED.test(segment)) return true;
  const labels = segment.toLowerCase().split(".");
  return labels.length >= 2 && HOST_TLDS.has(labels[labels.length - 1]);
}

/** A path and the position written after it. */
export function splitPosition(text: string): { path: string; line?: number; column?: number } {
  const match = text.match(POSITION_SUFFIX) ?? text.match(POSITION_HASH);
  if (!match || match.index === undefined) return { path: text };
  const line = Number(match[1]);
  const column = match[2] === undefined ? undefined : Number(match[2]);
  return {
    path: text.slice(0, match.index),
    ...(line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  };
}

/**
 * The file path inline code names, or null when it is something else.
 *
 * A candidate needs a slash or a position (`a.ts:12`), must not hold
 * whitespace, a backtick, glob characters or a scheme, and its last segment
 * must look like a file name: an extension that is not a version number, or a
 * well-known extensionless name. Paths written with `./`, `../`, `~/` or a
 * leading `/` are taken at their word for the last segment.
 */
export function inlineCodePathCandidate(code: string): {
  path: string;
  line?: number;
  column?: number;
} | null {
  const text = code.trim();
  if (!text || /[\s`]/.test(text) || text.length > 400) return null;
  if (URL_SCHEME.test(text) || OTHER_SCHEME.test(text)) return null;
  const position = splitPosition(text);
  const { path } = position;
  const hasPosition = position.line !== undefined;
  if (!path || GLOB_CHARS.test(path) || path.includes("//")) return null;
  // A remaining colon is a scheme or a `host:port`, not a path.
  if (path.includes(":") || path.includes("#")) return null;
  if (!hasPosition && !path.includes("/")) return null;
  if (path.endsWith("/")) return null;

  const explicit = RELATIVE_PREFIX.test(path) || path.startsWith("~/") || path.startsWith("/");
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (!base || base === "." || base === "..") return null;
  if (!explicit) {
    const first = path.split("/")[0];
    if (looksLikeHost(first)) return null;
  }
  if (EXTENSIONLESS_FILES.has(base)) return position;
  if (!FILE_EXTENSION.test(base) || VERSION_SUFFIX.test(base)) return null;
  return position;
}

/**
 * The file a link destination names, or null when it is a URL, an anchor, or
 * not file-shaped. A link may name a folder (`docs/`), and its text may be
 * anything: `[the helper](src/lib/api.ts#L10)`.
 */
export function linkHrefPathCandidate(href: string): {
  path: string;
  line?: number;
  column?: number;
  folder: boolean;
} | null {
  let text = href.trim();
  if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1);
  if (!text || text.startsWith("#") || text.startsWith("//")) return null;
  if (/^file:\/\//i.test(text)) text = text.slice("file://".length);
  else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) && !POSITION_SUFFIX.test(text)) return null;
  try {
    text = decodeURIComponent(text);
  } catch {
    /* keep it as written */
  }
  // A query string is a web thing; a file link has none.
  if (text.includes("?")) return null;
  const position = splitPosition(text);
  let { path } = position;
  if (!path || GLOB_CHARS.test(path) || path.includes(":") || path.includes("#")) return null;
  const folder = path.endsWith("/");
  if (folder) path = path.replace(/\/+$/, "");
  if (!path) return null;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const explicit = RELATIVE_PREFIX.test(path) || path.startsWith("~/") || path.startsWith("/");
  if (!explicit && looksLikeHost(path.split("/")[0])) return null;
  if (!folder && !EXTENSIONLESS_FILES.has(base)) {
    if (!FILE_EXTENSION.test(base) || VERSION_SUFFIX.test(base)) return null;
  }
  return { ...position, path, folder };
}

/** Collapse `.` and `..` segments. Null when `..` climbs above the root. */
function normalise(absolute: string): string | null {
  const out: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`;
}

/** The home directory a project root sits under, for `~/` paths. */
function homeOf(root: string): string | null {
  const match = root.match(/^\/(?:Users|home)\/[^/]+/);
  return match ? match[0] : null;
}

/**
 * Where `path` lands, if inside `root`: relative paths resolve against the
 * root, `~/` against the home the root sits in, and absolute paths are taken
 * as they are. Anything that ends up outside the root is null.
 */
export function resolveInProject(path: string, root: string): string | null {
  const cleanRoot = normalise(root.replace(/\\/g, "/"));
  if (!cleanRoot || cleanRoot === "/") return null;
  let absolute: string;
  if (path.startsWith("/")) absolute = path;
  else if (path.startsWith("~/")) {
    const home = homeOf(cleanRoot);
    if (!home) return null;
    absolute = `${home}/${path.slice(2)}`;
  } else absolute = `${cleanRoot}/${path}`;
  const resolved = normalise(absolute);
  if (!resolved) return null;
  return resolved === cleanRoot || resolved.startsWith(`${cleanRoot}/`) ? resolved : null;
}

/** The project file inline code names, or null. */
export function inlineCodeFileTarget(code: string, root: string): FileLinkTarget | null {
  const candidate = inlineCodePathCandidate(code);
  if (!candidate) return null;
  const path = resolveInProject(candidate.path, root);
  if (!path) return null;
  return { ...candidate, path, folder: false };
}

/** The project file or folder a link destination names, or null. */
export function linkFileTarget(href: string, root: string): FileLinkTarget | null {
  const candidate = linkHrefPathCandidate(href);
  if (!candidate) return null;
  const path = resolveInProject(candidate.path, root);
  if (!path) return null;
  return { ...candidate, path };
}

/** What a chip says: the base name, with the line when one was named. */
export function fileChipLabel(target: FileLinkTarget): string {
  const base = target.path.slice(target.path.lastIndexOf("/") + 1);
  return target.line === undefined ? base : `${base}:${target.line}`;
}

/** The full path a chip's tooltip shows, with the position when named. */
export function fileChipTitle(target: FileLinkTarget): string {
  if (target.line === undefined) return target.path;
  return `${target.path}:${target.line}${target.column === undefined ? "" : `:${target.column}`}`;
}

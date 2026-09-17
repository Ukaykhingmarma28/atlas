// The fake project's files, with real content.
//
// The editor, the SVG tab, the media tab and the diff view all read bytes
// through `invoke()`, so a handful of files with genuine source in them is the
// difference between CodeMirror mounting on an empty document and CodeMirror
// mounting on something a syntax theme can actually be judged against. Each
// language the editor highlights differently gets one file: TypeScript, TSX,
// Rust, JSON, Markdown, CSS — plus an SVG, a PNG, and an extensionless dotfile
// that only opens because `is_text_file` sniffs it.
//
// Writes land here too: `write_file_content` mutates the map and bumps the
// mtime, so save → reload → diff behaves like a real round trip for the rest of
// the session.

import type { FileEntry } from "@/features/explorer/stores/explorer-store";
import type {
  FileIndexStatus,
  FileMatch,
  FolderMatch,
} from "@/features/file-picker/lib/file-picker-api";
import type { RecentFile } from "@/features/chat/stores/recent-files-store";
import type { MockHandlers } from "../types";
import { abs, MOCK_WORKSPACE } from "../workspace";

/** One file in the fake tree. Binary files carry base64 instead of text. */
interface MockFile {
  /** UTF-8 content, or null when the file is binary. */
  text: string | null;
  /** Standard base64 of the bytes — set for binary files only. */
  base64?: string;
  /** Media type, for the `convertFileSrc` stand-in. */
  mime?: string;
  mtimeMs: number;
}

const T0 = Date.parse("2026-09-17T09:12:00Z");

const API_TS = `import { z } from "zod";

const BASE = import.meta.env.VITE_API_BASE ?? "https://api.acme.dev";

export const User = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1).max(64),
  createdAt: z.coerce.date(),
  plan: z.enum(["free", "team", "enterprise"]),
});

export type User = z.infer<typeof User>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(\`\${BASE}\${path}\`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    throw new ApiError(res.status, \`\${init?.method ?? "GET"} \${path} failed\`);
  }
  return (await res.json()) as T;
}

export const api = {
  getUser: (id: string) => request<User>(\`/users/\${id}\`),
  listUsers: (page = 0, size = 50) => request<User[]>(\`/users?page=\${page}&size=\${size}\`),
  updateUser: (id: string, patch: Partial<User>) =>
    request<User>(\`/users/\${id}\`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteUser: (id: string) => request<void>(\`/users/\${id}\`, { method: "DELETE" }),
};

/** Retry a request with exponential backoff — 5xx and network errors only. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) throw err;
      lastError = err;
      await new Promise((r) => setTimeout(r, 2 ** i * 250));
    }
  }
  throw lastError;
}
`;

const UTILS_TS = `export type Falsy = false | 0 | "" | null | undefined;

/** Join class names, dropping anything falsy. */
export function cx(...parts: (string | Falsy)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function formatBytes(bytes: number, digits = 1): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return \`\${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : digits)} \${units[exp]}\`;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms = 120) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const DIVISIONS = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
] as const;

export function timeAgo(from: Date, now = new Date()): string {
  let duration = (from.getTime() - now.getTime()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return RELATIVE.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return RELATIVE.format(Math.round(duration), "week");
}
`;

const BUTTON_TSX = `import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cx } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent/90",
  secondary: "bg-surface text-primary border border-default hover:bg-hover",
  ghost: "bg-transparent text-secondary hover:bg-hover",
  danger: "bg-red-600 text-white hover:bg-red-500",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2 text-[11px]",
  md: "h-8 px-3 text-[12px]",
  lg: "h-10 px-4 text-[13px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium",
        "transition-colors disabled:opacity-50 disabled:pointer-events-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading && <span className="size-3 animate-spin rounded-full border-2 border-current" />}
      {children}
    </button>
  );
});
`;

// Untracked in the fake repo — its whole-file diff is the "everything added"
// state the diff view has to render.
const BADGE_TSX = `import { cx } from "@/lib/utils";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface text-secondary border-default",
  info: "bg-accent/10 text-accent border-accent/30",
  success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  warning: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  danger: "bg-red-500/10 text-red-400 border-red-500/30",
};

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center rounded-full border px-2 text-[10px] font-medium",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
`;

const HEADER_TSX = `import { useState } from "react";
import { Button } from "./button";
import { cx } from "@/lib/utils";

interface HeaderProps {
  title: string;
  subtitle?: string;
  onSearch?: (query: string) => void;
}

export function Header({ title, subtitle, onSearch }: HeaderProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  return (
    <header className="flex items-center gap-3 border-b border-default px-4 h-12">
      <div className="min-w-0">
        <h1 className="truncate text-[13px] font-semibold text-primary">{title}</h1>
        {subtitle ? <p className="truncate text-[11px] text-secondary">{subtitle}</p> : null}
      </div>
      <form
        className={cx("ml-auto flex items-center gap-2", open ? "w-72" : "w-40")}
        onSubmit={(event) => {
          event.preventDefault();
          onSearch?.(query.trim());
        }}
      >
        <input
          value={query}
          placeholder="Search users…"
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(event) => setQuery(event.target.value)}
          className="h-7 w-full rounded-md bg-surface px-2 text-[12px] outline-none"
        />
        <Button size="sm" type="submit" disabled={!query.trim()}>
          Search
        </Button>
      </form>
    </header>
  );
}
`;

const MAIN_TSX = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Header } from "./components/header";
import { api } from "./lib/api";
import "./styles/tokens.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Header
        title="Acme"
        subtitle="Internal admin"
        onSearch={(q) => void api.listUsers(0, 50).then((users) => console.log(q, users.length))}
      />
      <main className="p-4" />
    </QueryClientProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

const LIB_RS = `use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;

/// A user as the desktop shell caches it between launches.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub plan: Plan,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Free,
    Team,
    Enterprise,
}

impl Plan {
    pub const fn seat_limit(self) -> Option<u32> {
        match self {
            Plan::Free => Some(3),
            Plan::Team => Some(50),
            Plan::Enterprise => None,
        }
    }
}

#[derive(Default)]
pub struct Cache {
    users: Mutex<BTreeMap<String, User>>,
}

impl Cache {
    pub fn insert(&self, user: User) -> Option<User> {
        let mut guard = self.users.lock().expect("cache poisoned");
        guard.insert(user.id.clone(), user)
    }

    pub fn get(&self, id: &str) -> Option<User> {
        self.users.lock().ok()?.get(id).cloned()
    }

    pub fn len(&self) -> usize {
        self.users.lock().map(|g| g.len()).unwrap_or(0)
    }
}

#[tauri::command]
pub async fn seat_limit(plan: Plan) -> Result<Option<u32>, String> {
    Ok(plan.seat_limit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enterprise_is_unlimited() {
        assert_eq!(Plan::Enterprise.seat_limit(), None);
        assert_eq!(Plan::Free.seat_limit(), Some(3));
    }
}
`;

const TOKENS_CSS = `:root {
  --bg-base: #0f1115;
  --bg-surface: #161920;
  --bg-hover: #1d212b;
  --border-default: #262b36;
  --text-primary: #e6e9ef;
  --text-secondary: #9aa3b2;
  --accent: #6e9cff;
  --danger: #f2555a;
  --radius-sm: 4px;
  --radius-md: 6px;
  --font-ui: "Inter", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg-base: #ffffff;
    --bg-surface: #f6f7f9;
    --bg-hover: #edeff3;
    --border-default: #dfe3ea;
    --text-primary: #12141a;
    --text-secondary: #5b6472;
  }
}

body {
  margin: 0;
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}

.card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  transition: background 120ms ease-out;
}

.card:hover {
  background: var(--bg-hover);
}

.card[data-state="disabled"] {
  opacity: 0.45;
  pointer-events: none;
}
`;

const PACKAGE_JSON = `{
  "name": "acme-app",
  "private": true,
  "version": "2.4.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "lint": "oxlint src"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.59.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "typescript": "^5.6.3",
    "vite": "^6.0.1",
    "vitest": "^2.1.4"
  },
  "engines": {
    "node": ">=20.11"
  }
}
`;

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noEmit": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
`;

const README_MD = `# acme-app

Internal admin for the Acme platform. React 19 + Vite on the front, a thin
Tauri shell around it for the desktop build.

## Getting started

\`\`\`bash
bun install
bun run dev        # http://localhost:5173
bun run test       # vitest
\`\`\`

## Layout

| Path | What lives there |
| --- | --- |
| \`src/components\` | Presentational components, no data fetching |
| \`src/lib\` | API client, formatting helpers |
| \`src/styles\` | Design tokens — the only place raw colours appear |
| \`src-tauri\` | Desktop shell (Rust) |

## Conventions

- Every colour is a token in \`src/styles/tokens.css\`. No hex literals in JSX.
- Components take data as props; fetching happens in route files.
- \`zod\` schemas are the source of truth for API types — never hand-write them.

> **Note**
> The \`/users\` endpoint moves to \`/v2/users\` in the next release. See
> [ACME-1184](https://example.invalid/ACME-1184) before touching \`src/lib/api.ts\`.
`;

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6e9cff" />
      <stop offset="100%" stop-color="#b07bff" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="#12141a" />
  <path d="M32 12 L50 50 H42 L32 28 L22 50 H14 Z" fill="url(#g)" />
  <circle cx="32" cy="45" r="4" fill="#12141a" />
</svg>
`;

const ENV_LOCAL = `# Local overrides — not committed. Opens in the editor only because
# \`is_text_file\` sniffs the bytes: ".local" is not a known text extension.
VITE_API_BASE=https://api.staging.acme.dev
VITE_SENTRY_DSN=
VITE_FEATURE_V2_USERS=true
`;

const LOGO_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABS0lEQVR42u3cwW3DMAwAQA5R5NUZO1F2TTYI6ogUJfkAPmOZuOgji2T8PH7FhwgEgAABAgQIECBAAhAgQIAAAfpf/D1fV+MWQF+49ErFXjTzmWJHmplMsS/NHKbYnaaaKY7RKTKKk3QqjOIkmgqmOFIn0ShO1ckyAlQPtKxOilEseIBYyih6dVZ70UJA679uFCgr1/Tf5xpF+xevoqeagRLzq3swxWgS0MhSc9LIBMpNq/rxQaNyoPHVJuczCpT+j00GumoUvdsnBah0EwFKBWo5RjTmBqgPKHHN3vQAAQIECNDdgHLX7M3QDgIECBAgQICc5gH5oghoPaA73mq4F3Oz6m5edUc/kPogFWZqFFW59gOpk1Zpr1cDkH6xHfrFdBzqWdX1rG/e5AWzO86b3WH6i/lBJlCZUgYIECBAgAABAiQAAQIECNBm8QYWuraEwe75dgAAAABJRU5ErkJggg==";

/** Working-tree content, keyed by path relative to the workspace root. */
const SEED: Record<string, MockFile> = {
  "src/lib/api.ts": { text: API_TS, mtimeMs: T0 },
  "src/lib/utils.ts": { text: UTILS_TS, mtimeMs: T0 - 86_400_000 },
  "src/components/badge.tsx": { text: BADGE_TSX, mtimeMs: T0 - 300_000 },
  "src/components/button.tsx": { text: BUTTON_TSX, mtimeMs: T0 - 3_600_000 },
  "src/components/header.tsx": { text: HEADER_TSX, mtimeMs: T0 - 7_200_000 },
  "src/main.tsx": { text: MAIN_TSX, mtimeMs: T0 - 172_800_000 },
  "src/styles/tokens.css": { text: TOKENS_CSS, mtimeMs: T0 - 600_000 },
  "src-tauri/src/lib.rs": { text: LIB_RS, mtimeMs: T0 - 259_200_000 },
  "package.json": { text: PACKAGE_JSON, mtimeMs: T0 - 432_000_000 },
  "tsconfig.json": { text: TSCONFIG_JSON, mtimeMs: T0 - 604_800_000 },
  "README.md": { text: README_MD, mtimeMs: T0 - 1_800_000 },
  ".env.local": { text: ENV_LOCAL, mtimeMs: T0 - 900_000 },
  "public/favicon.svg": { text: FAVICON_SVG, mtimeMs: T0 - 1_209_600_000 },
  "public/logo.png": {
    text: null,
    base64: LOGO_PNG_BASE64,
    mime: "image/png",
    mtimeMs: T0 - 1_209_600_000,
  },
};

/**
 * Live tree — absolute path → file. Writes mutate it for the session; a page
 * reload re-evaluates this module and puts the seed back.
 */
const files = new Map<string, MockFile>(
  Object.entries(SEED).map(([rel, file]) => [abs(rel), { ...file }]),
);

/** Working-tree text of a seeded file, by workspace-relative path. */
export function fileText(rel: string): string {
  return files.get(abs(rel))?.text ?? "";
}

/** Every file path in the fake tree, relative to the workspace root. */
export function mockFilePaths(): string[] {
  return Object.keys(SEED);
}

function byteLength(file: MockFile): number {
  if (file.text !== null) return new TextEncoder().encode(file.text).length;
  return Math.floor(((file.base64?.length ?? 0) * 3) / 4);
}

/**
 * `read_directory` over the fake tree: one level of the seeded file map, with
 * the directories that contain those files synthesised. Paths outside the
 * workspace root list as empty rather than throwing — the sidebar asks about
 * every workspace it knows, and only this one has files.
 */
export function listDir(absPath: string): FileEntry[] {
  const root = MOCK_WORKSPACE.path;
  if (absPath !== root && !absPath.startsWith(`${root}/`)) return [];
  const rel = absPath === root ? "" : `${absPath.slice(root.length + 1).replace(/\/$/, "")}/`;

  const dirs = new Set<string>();
  const here: FileEntry[] = [];
  for (const path of mockFilePaths()) {
    if (!path.startsWith(rel)) continue;
    const tail = path.slice(rel.length);
    const slash = tail.indexOf("/");
    if (slash === -1) {
      const file = files.get(abs(path));
      const dot = tail.lastIndexOf(".");
      here.push({
        name: tail,
        path: abs(path),
        is_dir: false,
        is_symlink: false,
        size: file ? byteLength(file) : 0,
        extension: dot > 0 ? tail.slice(dot + 1) : null,
      });
    } else {
      dirs.add(tail.slice(0, slash));
    }
  }

  const dirEntries: FileEntry[] = [...dirs].sort().map((name) => ({
    name,
    path: abs(`${rel}${name}`),
    is_dir: true,
    is_symlink: false,
    size: 0,
    extension: null,
  }));
  // Rust sorts directories first, then case-insensitive by name.
  here.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return [...dirEntries, ...here];
}

/**
 * Stand in for Tauri's `convertFileSrc`, which the media viewer uses instead of
 * `invoke()`: its `asset://` URL resolves to nothing in a plain browser, so a
 * seeded binary is served as a `data:` URL and everything else keeps the
 * default mock behaviour (a visibly broken image — the real "file is missing"
 * state).
 */
export function mockAssetUrl(path: string, fallback: (p: string) => string): string {
  const file = files.get(path.split("?")[0]);
  if (!file?.base64) return fallback(path);
  // The trailing `#` matters: the media viewer appends its own `?v=<mtime>`
  // cache-buster to whatever comes back, and that would otherwise land inside
  // the base64 payload. After a `#` it is a fragment, which the data URL
  // ignores.
  return `data:${file.mime ?? "application/octet-stream"};base64,${file.base64}#`;
}

/** Subsequence match on the path, which is what the Rust index does. */
function fuzzy(query: string, candidate: string): boolean {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return true;
  const hay = candidate.toLowerCase();
  let at = 0;
  for (const ch of needle) {
    at = hay.indexOf(ch, at);
    if (at === -1) return false;
    at++;
  }
  return true;
}

function dirPaths(): string[] {
  const dirs = new Set<string>();
  for (const path of mockFilePaths()) {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].sort();
}

/**
 * The "recently opened" queue Rust owns. Seeded, because the `@` picker's
 * first section is Recents and an empty one hides that whole row group.
 */
let recents: RecentFile[] = [
  { absPath: abs("src/lib/api.ts"), rel: "src/lib/api.ts", touchedAt: T0 },
  { absPath: abs("src/styles/tokens.css"), rel: "src/styles/tokens.css", touchedAt: T0 - 600_000 },
  { absPath: abs("README.md"), rel: "README.md", touchedAt: T0 - 1_800_000 },
];

export const fsHandlers: MockHandlers = {
  // Cmd+P and the `@` picker both go through the file index, so without these
  // there is no way to open a file into the editor at all.
  fileindex_open_project: (): number => mockFilePaths().length,
  fileindex_status: (): FileIndexStatus => ({
    indexed: true,
    count: mockFilePaths().length,
    root: MOCK_WORKSPACE.path,
  }),
  fileindex_search: ({ query, limit }): FileMatch[] =>
    mockFilePaths()
      .filter((rel) => fuzzy(String(query ?? ""), rel))
      .slice(0, Number(limit ?? 100))
      .map((rel) => ({ path: abs(rel), rel })),
  fileindex_search_dirs: ({ query, limit }): FolderMatch[] =>
    dirPaths()
      .filter((rel) => fuzzy(String(query ?? ""), rel))
      .slice(0, Number(limit ?? 30))
      .map((rel) => ({ path: abs(rel), rel })),

  recent_files_open_project: (): RecentFile[] => recents,
  // Returns the NEW list; the store writes it straight into state, so `null`
  // here is what takes the `@` picker down.
  recent_files_push: ({ absPath, rel }): RecentFile[] => {
    recents = [
      { absPath: String(absPath), rel: String(rel), touchedAt: Date.now() },
      ...recents.filter((entry) => entry.absPath !== String(absPath)),
    ].slice(0, 20);
    return recents;
  },
  recent_files_clear: (): null => {
    recents = [];
    return null;
  },

  read_file_content: ({ path }): string => {
    const file = files.get(String(path));
    if (!file || file.text === null) throw new Error(`Failed to read ${String(path)}: not found`);
    return file.text;
  },
  write_file_content: ({ path, content }): null => {
    const key = String(path);
    files.set(key, {
      mime: "text/plain",
      ...files.get(key),
      text: String(content),
      mtimeMs: Date.now(),
    });
    return null;
  },
  // Rust returns 0 rather than failing for a missing file.
  file_mtime_ms: ({ path }): number => files.get(String(path))?.mtimeMs ?? 0,
  is_text_file: ({ path }): boolean => {
    const file = files.get(String(path));
    // Unknown paths sniff as text, like an empty file does in Rust.
    return file ? file.text !== null : true;
  },
  read_file_base64: ({ path }): string => {
    const file = files.get(String(path));
    if (!file) throw new Error(`Failed to read ${String(path)}: not found`);
    if (file.base64) return file.base64;
    return btoa(String.fromCharCode(...new TextEncoder().encode(file.text ?? "")));
  },
  write_file_base64: ({ path, contents }): null => {
    const key = String(path);
    files.set(key, {
      mime: files.get(key)?.mime ?? "application/octet-stream",
      text: null,
      base64: String(contents),
      mtimeMs: Date.now(),
    });
    return null;
  },
};

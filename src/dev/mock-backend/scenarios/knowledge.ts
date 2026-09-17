// A populated knowledge base: ten linked notes across three folders, page
// metadata with icons, covers, status and tags, and two cloned repos. Opens
// straight onto the Knowledge tab.
//
// Everything is held in memory, so the panel can be clicked through: new,
// edited and deleted notes, new folders, meta patches and graph drags all
// show up in later answers, until the page reloads. Backlinks, link counts
// and the graph are derived from the current note bodies the same way
// `commands/knowledge_links.rs` does it.

import { emit } from "@tauri-apps/api/event";
import type { MentionData, MentionKnowledge } from "@/features/chat/lib/mentions";
import type { ClonedRepo } from "@/features/github/types";
import type { GraphLayout } from "@/features/knowledge/components/knowledge-graph";
import type {
  GraphEdge,
  GraphNode,
  ProjectGraph,
} from "@/features/knowledge/stores/knowledge-graph-store";
import type { Backlink, LinkCounts } from "@/features/knowledge/stores/knowledge-links-store";
import type {
  MetaFile,
  PageMetaPatch,
  RustPageMeta,
} from "@/features/knowledge/stores/knowledge-meta-store";
import type { KnowledgeEntry } from "@/features/knowledge/stores/knowledge-store";
import type { Scenario } from "../types";
import type { KbImportResult, KbServerExport } from "./base";
import {
  ago,
  coverSvgDataUrl,
  SEED_EMPTY_DIRS,
  SEED_META,
  SEED_NOTES,
  SEED_READMES,
  SEED_REPOS,
} from "../fixtures/knowledge";
import { MOCK_WORKSPACE } from "../workspace";

const PROJECT = MOCK_WORKSPACE.path;
const KB_DIR = `${PROJECT}/.atlas/knowledge`;

interface Note {
  content: string;
  updatedAt: string;
}

// ── state ─────────────────────────────────────────────────────────────────

let notes = new Map<string, Note>();
let dirs = new Set<string>();
let meta: Record<string, RustPageMeta> = {};
let repos: ClonedRepo[] = [];
let layout: GraphLayout = { positions: {} };

function reset(): void {
  notes = new Map(SEED_NOTES.map((n) => [n.id, { content: n.content, updatedAt: ago(n.age) }]));
  dirs = new Set(SEED_EMPTY_DIRS);
  meta = structuredClone(SEED_META);
  repos = structuredClone(SEED_REPOS);
  layout = { positions: {} };
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** Rust sends the filename stem as the title; `_meta.json` titles win client-side. */
const stem = (id: string) => id.split("/").pop() ?? id;

/** Same path rule as Rust's `kb_rel`: relative, no `..`, no backslashes. */
function kbRel(fragment: unknown): string {
  const f = String(fragment ?? "");
  if (
    !f ||
    f.includes("\\") ||
    f.startsWith("/") ||
    f.split("/").some((p) => !p || p === "." || p === "..")
  ) {
    throw new Error("invalid knowledge path");
  }
  return f;
}

function listEntries(): KnowledgeEntry[] {
  return [...notes]
    .map(([id, n]) => ({
      id,
      title: stem(id),
      content: n.content,
      source: stem(id).startsWith("paper-")
        ? "paper"
        : stem(id).startsWith("chat-")
          ? "chat"
          : "note",
      file_path: `${KB_DIR}/${id}.md`,
      updated_at: n.updatedAt,
    }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

// ── events ────────────────────────────────────────────────────────────────

const linksChanged = () => emit("atlas:knowledge:links-changed", { projectPath: PROJECT });

// Rust debounces meta writes by 300 ms and emits once the file is on disk.
let metaTimer: ReturnType<typeof setTimeout> | null = null;
function metaChanged(): void {
  if (metaTimer) clearTimeout(metaTimer);
  metaTimer = setTimeout(() => {
    metaTimer = null;
    void emit("atlas:knowledge:meta-changed", { projectPath: PROJECT });
  }, 300);
}

/** Re-read the note list the way the panel does after a write it made itself. */
async function reloadEntries(): Promise<void> {
  const { useKnowledgeStore } = await import("@/features/knowledge/stores/knowledge-store");
  await useKnowledgeStore.getState().actions.loadEntries(PROJECT);
}

// ── links (port of knowledge_links.rs) ──────────────────────────────────────

interface RefHit {
  target: string;
  start: number;
  end: number;
}

function findRefs(body: string): RefHit[] {
  const out: RefHit[] = [];
  // [[wikilinks]]
  for (let i = 0; i + 1 < body.length;) {
    if (body.startsWith("[[", i)) {
      const close = body.indexOf("]]", i + 2);
      if (close !== -1) {
        const inner = body.slice(i + 2, close);
        if (inner && !inner.includes("\n") && inner.length < 200) {
          out.push({ target: inner, start: i, end: close + 2 });
        }
        i = close + 2;
        continue;
      }
    }
    i++;
  }
  // @knowledge:id / @note:id / @page:id
  for (const m of body.matchAll(/@(?:knowledge|note|page):([^\s,;)\]}"'`]+)/g)) {
    out.push({ target: m[1], start: m.index, end: m.index + m[0].length });
  }
  // HTML mention chips: data-mention-kind first, data-id within 400 chars after.
  for (const m of body.matchAll(/data-mention-kind=(["'])(.*?)\1/g)) {
    if (!["knowledge", "note", "page"].includes(m[2])) continue;
    const window = body.slice(m.index, m.index + 400);
    const id = /data-id=(["'])(.*?)\1/.exec(window)?.[2];
    if (id) out.push({ target: id, start: m.index, end: m.index + 1 });
  }
  return out;
}

const SNIPPET_RADIUS = 90;

function snippet(body: string, start: number, end: number): string {
  const lo = Math.max(0, start - SNIPPET_RADIUS);
  const hi = Math.min(body.length, end + SNIPPET_RADIUS);
  const flat = (s: string) => s.replaceAll("\n", " ");
  const text = `${flat(body.slice(lo, start))}{{ ${flat(body.slice(start, end))} }}${flat(body.slice(end, hi))}`;
  return `${lo > 0 ? "…" : ""}${text.trim()}${hi < body.length ? "…" : ""}`;
}

interface LinkGraph {
  backlinks: Map<string, Backlink[]>;
  forward: Map<string, string[]>;
}

function buildGraph(): LinkGraph {
  const backlinks = new Map<string, Backlink[]>();
  const forward = new Map<string, string[]>();
  for (const [from, { content }] of notes) {
    const targets: string[] = [];
    for (const hit of findRefs(content)) {
      if (hit.target === from) continue;
      const list = backlinks.get(hit.target) ?? [];
      list.push({
        fromEntryId: from,
        fromTitle: stem(from),
        snippet: snippet(content, hit.start, hit.end),
      });
      backlinks.set(hit.target, list);
      if (!targets.includes(hit.target)) targets.push(hit.target);
    }
    forward.set(from, targets);
  }
  return { backlinks, forward };
}

function projectGraph(): ProjectGraph {
  const g = buildGraph();
  // Referenced-but-missing ids become nodes too, titled by their id.
  const titles = new Map<string, string>([...notes.keys()].map((id) => [id, stem(id)]));
  for (const id of [...g.backlinks.keys(), ...g.forward.keys()]) {
    if (!titles.has(id)) titles.set(id, id);
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const [from, targets] of g.forward) {
    for (const to of targets) {
      const key = from < to ? `${from}\0${to}` : `${to}\0${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to });
    }
  }
  const nodes: GraphNode[] = [...titles]
    .map(([id, title]) => ({
      id,
      title,
      inDegree: g.backlinks.get(id)?.length ?? 0,
      outDegree: g.forward.get(id)?.length ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}

// ── console triggers ───────────────────────────────────────────────────────

let added = 0;

async function addNote(): Promise<void> {
  added += 1;
  const id = `meeting-notes/2026-09-${String(17 + added).padStart(2, "0")}-sync`;
  notes.set(id, {
    content: `# Weekly sync ${added}\n\n- Passkey rollout is on track ([[architecture/auth-flow]])\n- [ ] Follow up on [[roadmap-q4]]\n`,
    updatedAt: now(),
  });
  meta[id] = {
    icon: "🗓️",
    title: `Weekly sync ${added}`,
    tags: ["meetings"],
    created_at: now(),
    updated_at: now(),
  };
  metaChanged();
  await reloadEntries();
  await linksChanged();
}

async function externalEdit(): Promise<void> {
  // Another tool appends a link to the data model from the onboarding page,
  // then the frontend is told the link graph and file list changed.
  const id = "guides/onboarding";
  const note = notes.get(id);
  if (!note) return;
  note.content += `\n## Appendix\n\nThe schema reference is [[architecture/data-model]].\n`;
  note.updatedAt = now();
  await reloadEntries();
  await linksChanged();
}

// ── scenario ───────────────────────────────────────────────────────────────

export const knowledge: Scenario = {
  name: "knowledge",
  description:
    "Knowledge tab with 10 linked notes in 3 folders, icons/covers/status/tags, a graph and 2 cloned repos.",
  init: reset,
  setup: async () => {
    const { useLayoutStore } = await import("@/features/layout/stores/layout-store");
    const { actions, tabs } = useLayoutStore.getState();
    const existing = tabs.find((t) => t.type === "knowledge");
    if (existing) actions.setActiveTab(existing.id);
    else
      actions.addTab({
        id: "knowledge",
        type: "knowledge",
        title: "Knowledge",
        closable: true,
        dirty: false,
        data: {},
      });
  },
  actions: {
    /** Add a linked note in a new folder: `__atlasMock.actions.addNote()`. */
    addNote,
    /** Simulate another tool editing a note on disk (adds a backlink). */
    externalEdit,
    /** Restore the seed data and reload the list. */
    reset: async () => {
      reset();
      metaChanged();
      await reloadEntries();
      await linksChanged();
    },
  },
  commands: {
    // ── notes ──
    list_knowledge: (): KnowledgeEntry[] => listEntries(),
    save_knowledge_note: ({ id, content }): string => {
      const rel = kbRel(id);
      notes.set(rel, { content: String(content), updatedAt: now() });
      return `${KB_DIR}/${rel}.md`;
    },
    delete_knowledge_note: ({ id }) => {
      notes.delete(kbRel(id));
      return null;
    },
    create_knowledge_dir: ({ dirName }) => {
      dirs.add(kbRel(dirName));
      return null;
    },
    import_into_knowledge: ({ sources }): KbImportResult => {
      let imported = 0;
      for (const src of sources as string[]) {
        const name = src
          .split("/")
          .pop()
          ?.replace(/\.(md|markdown)$/i, "");
        if (!name) continue;
        notes.set(name, { content: `# ${name}\n\nImported from \`${src}\`.\n`, updatedAt: now() });
        imported += 1;
      }
      return { notes_imported: imported, files_copied: 0 };
    },

    // ── metadata ──
    knowledge_meta_load: (): MetaFile => ({ version: 1, pages: structuredClone(meta) }),
    knowledge_meta_patch: ({ entryId, patch }): RustPageMeta => {
      const p = patch as PageMetaPatch;
      const page: RustPageMeta = (meta[entryId] ??= {});
      page.created_at ??= now();
      for (const key of ["icon", "cover", "title", "status", "tags", "owner"] as const) {
        if (p[key] !== undefined) Object.assign(page, { [key]: p[key] });
      }
      page.updated_at = now();
      metaChanged();
      return structuredClone(page);
    },
    knowledge_meta_delete: ({ entryId }) => {
      delete meta[entryId];
      metaChanged();
      return null;
    },

    // ── links + graph ──
    knowledge_backlinks: ({ entryId }): Backlink[] => buildGraph().backlinks.get(entryId) ?? [],
    knowledge_link_counts: ({ entryId }): LinkCounts => {
      const g = buildGraph();
      return {
        backlinks: g.backlinks.get(entryId)?.length ?? 0,
        forwardlinks: g.forward.get(entryId)?.length ?? 0,
      };
    },
    knowledge_links_graph: (): ProjectGraph => projectGraph(),
    knowledge_links_invalidate: async () => {
      await linksChanged();
      return null;
    },
    knowledge_graph_layout_load: (): GraphLayout => structuredClone(layout),
    knowledge_graph_layout_save: ({ layout: next }) => {
      layout = next as GraphLayout;
      return null;
    },

    // ── covers ──
    knowledge_cover_data_url: ({ cover }): string => {
      if (String(cover).startsWith("gradient:")) return cover;
      return coverSvgDataUrl(kbRel(cover));
    },
    knowledge_cover_upload: ({ entryId, srcPath }): string => {
      const ext = String(srcPath).split(".").pop()?.toLowerCase() ?? "jpg";
      return `covers/${String(entryId).replaceAll("/", "__")}.${ext}`;
    },

    // ── editor `@` / `~` picker: knowledge results only ──
    mention_search: ({ query, scope }): MentionData[] => {
      if (scope !== null && scope !== "knowledge") return [];
      const q = String(query ?? "").toLowerCase();
      return listEntries()
        .map((e): MentionKnowledge => {
          const slash = e.id.lastIndexOf("/");
          return {
            kind: "knowledge",
            id: e.id,
            displayName: meta[e.id]?.title?.trim() || e.title,
            icon: meta[e.id]?.icon ?? null,
            filePath: e.file_path,
            source: e.source,
            folder: slash > 0 ? e.id.slice(0, slash) : null,
          };
        })
        .filter((m) => !q || m.displayName.toLowerCase().includes(q) || m.id.includes(q))
        .slice(0, 20);
    },

    // ── cloned repos ──
    list_cloned_repos: (): ClonedRepo[] => structuredClone(repos),
    read_repo_readme: ({ repoName }): string => {
      const readme = SEED_READMES[repoName];
      if (readme === undefined || !repos.some((r) => r.name === repoName)) {
        throw new Error("No README found");
      }
      return readme;
    },
    delete_cloned_repo: ({ repoName }) => {
      repos = repos.filter((r) => r.name !== repoName);
      return null;
    },

    // ── export (paths come from the save dialog below) ──
    knowledge_export_server: (): KbServerExport => ({
      binaryPath: "/Users/dev/Downloads/atlas-kb-server",
      noteCount: notes.size,
    }),
    // The browser has no native dialogs. Pick a cover image when asked for
    // one, "save" exports to Downloads, and cancel every other picker.
    "plugin:dialog|open": ({ options }) => {
      const images = (options?.filters ?? []).some((f: { extensions: string[] }) =>
        f.extensions.includes("png"),
      );
      return images ? "/Users/dev/Pictures/cover.png" : null;
    },
    "plugin:dialog|save": ({ options }) =>
      `/Users/dev/Downloads/${options?.defaultPath ?? "export"}`,
  },
};

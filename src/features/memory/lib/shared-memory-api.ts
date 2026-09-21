// Shared Cross-Agent Memory (v2) — TS bindings for the per-project event log
// + derived state view. The capture/injection happen Rust-side
// (`agents_send` + `TauriDeltaSink::emit`); these commands let the Memory panel
// read the current view, run an on-demand query, and clear a project's memory.
// Mirrors the plain-invoke pattern in `memory-sharing-api.ts`.

import { invoke } from "@tauri-apps/api/core";

export type EventKind =
  | "plan_set"
  | "decision"
  | "file_changed"
  | "fact"
  | "failure"
  | "architecture"
  | "session_start"
  | "session_end"
  | "todo_added"
  | "todo_done";

export interface MemoryEvent {
  seq: number;
  ts: number;
  agent: string;
  sessionId: string;
  kind: EventKind;
  key: string;
  payload: Record<string, unknown>;
}

export interface PlanView {
  seq: number;
  agent: string;
  text: string;
  status: string;
}

export interface DecisionView {
  seq: number;
  agent: string;
  key: string;
  text: string;
}

export interface ChangeView {
  seq: number;
  agent: string;
  path: string;
  summary: string;
}

export interface FactView {
  seq: number;
  agent: string;
  text: string;
}

export interface SharedState {
  lastSeq: number;
  activePlan?: PlanView | null;
  decisions: DecisionView[];
  recentChanges: ChangeView[];
  facts: FactView[];
  failures: FactView[];
  architecture: FactView[];
  sessionAgents: Record<string, string>;
  updatedAt: number;
}

/** Which of the six kinds a record entry is. */
export type EntryKind = "plan" | "decision" | "file_changed" | "fact" | "failure" | "architecture";

/** One record entry with its provenance and confidence (the Memories view). */
export interface MemoryEntry {
  id: number;
  kind: EntryKind;
  key: string;
  content: string;
  status: string;
  /** An agent id, `extractor`, `user`, or `import:<origin>`. */
  source: string;
  /** The agent the memory came from; empty for an import. */
  agent: string;
  sessionId: string;
  /** 0–1: the extractor's model confidence; 1 for tool and user writes. */
  confidence: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  uses: number;
}

/** One line an import of Claude's auto-memory would write (the preview). */
export interface ClaudeImportLine {
  /** Stable id of the line; what confirm takes. */
  id: string;
  /** `fact`, or `decision` for a project memory that states a choice. */
  kind: EntryKind;
  content: string;
  /** The Claude memory file it came from. */
  file: string;
  /** Claude's own frontmatter `type` (`user`, `feedback`, `project`, `reference`). */
  claudeType: string;
  /** `false` when already imported or already in memory: confirm skips it. */
  isNew: boolean;
}

export interface ClaudeImportPreview {
  /** The Claude memory directories read for this repository. */
  sources: string[];
  /** Every source was imported before (once per source). */
  alreadyImported: boolean;
  lines: ClaudeImportLine[];
}

export const sharedMemory = {
  getState: (projectPath: string) => invoke<SharedState>("memory_get_state", { projectPath }),
  query: (projectPath: string, query: string, limit = 20) =>
    invoke<MemoryEvent[]>("memory_query", { projectPath, query, limit }),
  listEvents: (projectPath: string) => invoke<MemoryEvent[]>("memory_list_events", { projectPath }),
  clear: (projectPath: string) => invoke<void>("memory_clear_project", { projectPath }),
  listEntries: (projectPath: string) =>
    invoke<MemoryEntry[]>("memory_list_entries", { projectPath }),
  /** Rewrite an entry's content as the user (source `user`, confidence 1). */
  editEntry: (projectPath: string, id: number, content: string) =>
    invoke<MemoryEntry>("memory_edit_entry", { projectPath, id, content }),
  /** Forget (delete) an entry. `false` when it was already gone. */
  forgetEntry: (projectPath: string, id: number) =>
    invoke<boolean>("memory_forget_entry", { projectPath, id }),
  /** What importing the project's Claude auto-memory would write. Writes nothing. */
  previewClaudeImport: (projectPath: string) =>
    invoke<ClaudeImportPreview>("memory_claude_import_preview", { projectPath }),
  /** Import the previewed lines in `ids` (source `import:claude`, confidence 0.7).
   *  Returns how many were written. */
  confirmClaudeImport: (projectPath: string, ids: string[]) =>
    invoke<number>("memory_claude_import_confirm", { projectPath, ids }),
  appendEvent: (
    projectPath: string,
    agent: string,
    sessionId: string,
    kind: EventKind,
    key: string | null,
    payload: Record<string, unknown>,
  ) =>
    invoke<number>("memory_append_event", {
      projectPath,
      agent,
      sessionId,
      kind,
      key,
      payload,
    }),
};

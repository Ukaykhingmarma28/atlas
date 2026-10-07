// Shared Cross-Agent Memory — TS bindings for the per-project toggle + handoff
// summarizer preference. Agents pull memory through the `atlas_memory` tools
// (ADR-0010); nothing is injected. These commands only read/write the two
// per-project settings files. Mirrors the plain-invoke pattern in
// `memory-policy-api.ts`.

import { invoke } from "@tauri-apps/api/core";

export type SummarizerMode = "raw" | "provider" | "local";

export interface SummarizerPref {
  /** "raw" = verbatim tail (default), "provider" = BYOK summary, "local" = Phase 5. */
  mode: SummarizerMode;
  /** Provider id (e.g. "anthropic") — only meaningful when mode === "provider". */
  provider: string;
  /** Model id (e.g. "claude-sonnet-4-5") — only meaningful when mode === "provider". */
  model: string;
}

export const memorySharing = {
  getEnabled: (projectPath: string) => invoke<boolean>("memory_sharing_get", { projectPath }),
  setEnabled: (projectPath: string, enabled: boolean) =>
    invoke<void>("memory_sharing_set", { projectPath, enabled }),
  getSummarizer: (projectPath: string) =>
    invoke<SummarizerPref>("memory_summarizer_get", { projectPath }),
  setSummarizer: (projectPath: string, pref: SummarizerPref) =>
    invoke<void>("memory_summarizer_set", { projectPath, pref }),
};

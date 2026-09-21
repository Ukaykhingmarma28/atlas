// What's genuinely specific to landing on the Knowledge tab: opening it on
// mount, and the console triggers that simulate work happening outside the
// panel. The populated knowledge base itself — notes, meta, backlinks and the
// graph — is part of `baseHandlers` now (`fixtures/knowledge.ts`), so every
// scenario has it; this scenario only adds these extras on top.

import type { Scenario } from "../types";
import {
  knowledgeHandlers,
  listKnowledgeEntries,
  reloadKnowledgeEntries,
  resetKnowledgeStore,
  scheduleKnowledgeMetaChanged,
} from "../fixtures/knowledge";

let added = 0;

async function addNote(): Promise<void> {
  added += 1;
  const id = `meeting-notes/2026-09-${String(17 + added).padStart(2, "0")}-sync`;
  knowledgeHandlers.save_knowledge_note({
    id,
    content: `# Weekly sync ${added}\n\n- Passkey rollout is on track ([[architecture/auth-flow]])\n- [ ] Follow up on [[roadmap-q4]]\n`,
  });
  knowledgeHandlers.knowledge_meta_patch({
    entryId: id,
    patch: { icon: "🗓️", title: `Weekly sync ${added}`, tags: ["meetings"] },
  });
  await reloadKnowledgeEntries();
  await knowledgeHandlers.knowledge_links_invalidate({});
}

async function externalEdit(): Promise<void> {
  // Another tool appends a link to the data model from the onboarding page,
  // then the frontend is told the link graph and file list changed.
  const id = "guides/onboarding";
  const note = listKnowledgeEntries().find((entry) => entry.id === id);
  if (!note) return;
  knowledgeHandlers.save_knowledge_note({
    id,
    content: `${note.content}\n## Appendix\n\nThe schema reference is [[architecture/data-model]].\n`,
  });
  await reloadKnowledgeEntries();
  await knowledgeHandlers.knowledge_links_invalidate({});
}

export const knowledge: Scenario = {
  name: "knowledge",
  description:
    "Knowledge tab with 10 linked notes in 3 folders, icons/covers/status/tags and a graph.",
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
      resetKnowledgeStore();
      scheduleKnowledgeMetaChanged();
      await reloadKnowledgeEntries();
      await knowledgeHandlers.knowledge_links_invalidate({});
    },
  },
};

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import type { MemorySubTab } from "../lib/memory-types";
import { memoryPolicy, type Policy } from "../lib/memory-policy-api";

/**
 * Module-level cache for the Memory module. The Memory tab isn't persistent —
 * switching center tabs (or Memory sub-tabs) unmounts/remounts the views — so
 * without this every visit re-ran the expensive Rust indexing (memory_policies).
 * This store survives remounts and is keyed by project: views
 * render cached data instantly (optimistic) and only fetch on first load, project
 * change, or an explicit refresh. (The graph keeps its own memory-graph-store,
 * which is already module-level and self-guards.)
 */

type PolicyPhase =
  | "idle"
  | "checking"
  | "not-downloaded"
  | "downloading"
  | "loading"
  | "ready"
  | "error";

interface MemoryStoreState {
  /** Active sub-tab, preserved across remounts. */
  subTab: MemorySubTab;
  /** Which project the caches below belong to (reset on change). */
  project: string | null;

  // Policy table.
  policies: Policy[] | null;
  policyPhase: PolicyPhase;
  policyError: string | null;

  actions: {
    setSubTab: (t: MemorySubTab) => void;
    /** Drop caches when the project changes. */
    ensureProject: (projectPath: string | null) => void;
    loadPolicies: (projectPath: string, force?: boolean) => Promise<void>;
    setPolicyPhase: (phase: PolicyPhase, error?: string | null) => void;
    setPolicies: (rows: Policy[]) => void;
    /** Optimistic in-place value update after an edit saves. */
    updatePolicyValue: (id: string, value: string) => void;
  };
}

export const useMemoryStore = createSelectors(
  create<MemoryStoreState>()((set, get) => ({
    subTab: "graph",
    project: null,
    policies: null,
    policyPhase: "idle",
    policyError: null,
    actions: {
      setSubTab: (t) => set({ subTab: t }),

      ensureProject: (projectPath) => {
        if (get().project === projectPath) return;
        // New project → invalidate every cache.
        set({
          project: projectPath,
          policies: null,
          policyPhase: "idle",
          policyError: null,
        });
      },

      loadPolicies: async (projectPath, force = false) => {
        const s = get();
        if (!force && s.project === projectPath && s.policies && s.policyPhase === "ready") {
          return; // cache hit — no re-index
        }
        set({ policyPhase: "loading", policyError: null });
        try {
          const rows = await memoryPolicy.list(projectPath);
          set({ policies: rows, policyPhase: "ready", project: projectPath });
        } catch (e) {
          const msg = String(e);
          if (msg.includes("model-not-downloaded")) {
            set({ policyPhase: "not-downloaded" });
          } else {
            set({ policyError: msg, policyPhase: "error" });
          }
        }
      },

      setPolicyPhase: (phase, error = null) => set({ policyPhase: phase, policyError: error }),
      setPolicies: (rows) => set({ policies: rows, policyPhase: "ready" }),
      updatePolicyValue: (id, value) =>
        set((st) => ({
          policies: st.policies?.map((p) => (p.id === id ? { ...p, value } : p)) ?? null,
        })),
    },
  })),
);

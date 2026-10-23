// Which view each review panel shows — its diff or the project's files.
// Persisted per panel (its tab id), so a relaunch reopens the view you left.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";

/** What a review surface shows. Each is a branch of `ReviewPanel` rather than
 *  a tab type, so the two share one surface the way they share one panel. */
export type ReviewView = "diff" | "files";

interface ReviewViewState {
  view: Record<string, ReviewView>;
  actions: {
    setView: (panel: string, view: ReviewView) => void;
  };
}

export const useReviewViewStore = createSelectors(
  create<ReviewViewState>()(
    persist(
      (set) => ({
        view: {},
        actions: {
          setView: (panel, view) => set((s) => ({ view: { ...s.view, [panel]: view } })),
        },
      }),
      { name: "atlas.git.review-view", partialize: (s) => ({ view: s.view }) },
    ),
  ),
);

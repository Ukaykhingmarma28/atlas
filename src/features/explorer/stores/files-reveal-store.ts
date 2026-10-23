// The path the Files surface was last asked to reveal (`ui_focus` explorer,
// `revealFiles(path)`). The surface's tree highlights it and opens every folder
// above it; a new request with the same path reveals it again (the nonce).
//
// Not persisted: a reveal is a one-off request. The Files tab closes itself on
// the first file opened from it, and `revealFiles()` without a path clears the
// request, so the tree goes back to following the file being read.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

interface FilesRevealState {
  /** Absolute. */
  request: { path: string; nonce: number } | null;
  actions: {
    reveal: (path: string | null) => void;
  };
}

let nonce = 0;

export const useFilesRevealStore = createSelectors(
  create<FilesRevealState>()((set) => ({
    request: null,
    actions: {
      reveal: (path) => set({ request: path === null ? null : { path, nonce: ++nonce } }),
    },
  })),
);

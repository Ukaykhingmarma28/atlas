import { useFilesRevealStore } from "@/features/explorer/stores/files-reveal-store";
import type { Tab } from "../stores/layout-store";
import { revealSingleton, toggleSingleton } from "./singleton-surface";

/**
 * Files is a surface: the project's tree, in a tab beside the session. One per
 * project (the layout store holds the active project's tabs, and `addTab`
 * focuses an open Files tab rather than adding a second).
 *
 * It is a way in, not a place to stay. Opening a file from it opens (or
 * focuses) that file's tab and closes this one; the file tab carries the same
 * tree beside it (`FileTabFrame`), so the tree is never shown twice.
 */
export const FILES_TAB: Tab = {
  id: "files",
  type: "files",
  title: "Files",
  closable: true,
  dirty: false,
  data: {},
};

/**
 * Bring the project's Files tab on screen, opening it when there is none. With
 * `path` (absolute), the tree opens every folder above it and highlights it;
 * without, it follows the file being read.
 */
export function revealFiles(path?: string): void {
  useFilesRevealStore.getState().actions.reveal(path ?? null);
  revealSingleton(FILES_TAB);
}

/** Close the Files tab when it is on screen, else reveal it. */
export function toggleFiles(): void {
  useFilesRevealStore.getState().actions.reveal(null);
  toggleSingleton(FILES_TAB);
}

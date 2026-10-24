// What a file tab's frame tells the file inside it: the project the file is
// shown in, whether a tab names it, and how its breadcrumbs reach the tree.
//
// The file's breadcrumbs walk the tree beside it. A folder crumb reveals that
// folder there (showing the tree first when it is hidden), and the crumbs keep
// the deeper trail down to the file so the way back is one click. The frame
// owns that state because the tree is its column, not the file's.

import { createContext, useContext } from "react";

export interface FileTabFrameValue {
  /** The tab's project root, absolute; null when the file is outside it. */
  root: string | null;
  projectName: string | null;
  /**
   * A tab in a strip names the file (icon, name, unsaved dot). False in the
   * main column, which has no strip: there the breadcrumbs carry the file's
   * identity themselves.
   */
  titled: boolean;
  /** The folder the crumbs walked up to, root-relative; null while at the file. */
  crumbFolder: string | null;
  /** Reveal a root-relative folder in the tree, showing the tree if hidden. */
  revealFolder: (path: string) => void;
  /** Back down to the file: reveal it in the tree again. */
  revealFile: () => void;
}

export const FileTabFrameContext = createContext<FileTabFrameValue | null>(null);

/** The frame around this file tab; null outside one. */
export function useFileTabFrame(): FileTabFrameValue | null {
  return useContext(FileTabFrameContext);
}

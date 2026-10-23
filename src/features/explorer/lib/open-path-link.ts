// Opening a file a session names: a `@file` chip in a sent message, or a
// path an agent wrote in its reply (`markdown-render.ts` turns both into
// chips; `markdown-links.ts` routes their clicks here).
//
// Inside the open project the file becomes an Atlas tab, through the same
// open path as a click in the file tree, with the cursor on the line the chip
// named. Anything Atlas has nowhere to place — outside the project, or no
// project open — goes to the app the system opens that file type with, as a
// file opened from a diff does (`open-review-file.ts`).

import { toast } from "sonner";
import { useAppStore } from "@/features/app/stores/app-store";
import { fileIndex } from "@/features/file-picker/lib/file-picker-api";
import { openInProject } from "./open-in-project";

/** What a chip carries. */
export interface PathLink {
  /** Absolute. */
  path: string;
  line?: number;
  column?: number;
  folder?: boolean;
}

function isUnder(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

/**
 * The file the project actually has at `path`, asked of the file index once,
 * at click time — never at render.
 *
 * An agent's path can be short of the project root (`api.ts:12`, or
 * `lib/api.ts` for `src/lib/api.ts`), which the renderer can only resolve
 * against the root. The index knows the real file: the exact path when it has
 * it, else the one file whose project-relative path ends with what was
 * written. Anything else — several candidates, no index, an error — keeps the
 * path as written, and the editor says if it is not there.
 */
export async function locateInProject(path: string, root: string): Promise<string> {
  const base = root.replace(/\/+$/, "");
  const rel = path.slice(base.length + 1);
  if (!rel) return path;
  try {
    const matches = await fileIndex.search(rel, 50);
    if (matches.some((m) => m.path === path)) return path;
    const tail = matches.filter((m) => m.rel === rel || m.rel.endsWith(`/${rel}`));
    return tail.length === 1 ? tail[0].path : path;
  } catch {
    return path;
  }
}

async function openWithSystem(path: string): Promise<void> {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  } catch (e) {
    toast.error("Couldn't open the file", { description: String(e) });
  }
}

export async function openPathLink(link: PathLink): Promise<void> {
  const root = useAppStore.getState().currentProject?.path ?? null;
  if (!root || !isUnder(link.path, root) || link.folder) {
    // A folder has no tab to open in; the system shows it in its file manager.
    await openWithSystem(link.path);
    return;
  }
  const path = await locateInProject(link.path, root);
  await openInProject(
    path,
    undefined,
    link.line === undefined ? undefined : { reveal: { line: link.line, column: link.column } },
  );
}

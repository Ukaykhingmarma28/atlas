import { activeProjectId } from "@/features/projects/lib/active-project";
import { fileKindOf, openFileAs } from "@/lib/open-file";

/**
 * Open `abs` as a tab of the project that is active now, then call
 * `onOpened`, unless the user has switched project by the time the file's
 * kind is known.
 *
 * Classifying a file can wait on the backend (a name with no known
 * extension, `Makefile`, is sniffed for text). The layout store holds the
 * ACTIVE project's tabs, so a tab opened after a switch would land in the
 * other project, and an `onOpened` that closes a tab by id (the Files
 * surface's `"files"`, the same id in every project) would close that
 * project's tab instead. A click in one project acts in that project or not
 * at all.
 */
export async function openInProject(abs: string, onOpened?: (abs: string) => void): Promise<void> {
  const project = activeProjectId();
  const kind = await fileKindOf(abs);
  if (activeProjectId() !== project) return;
  openFileAs(abs, kind);
  onOpened?.(abs);
}

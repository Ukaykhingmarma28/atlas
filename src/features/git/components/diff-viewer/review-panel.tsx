import { FolderTree } from "lucide-react";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import { revealFiles } from "@/features/layout/lib/files-surface";
import { DiffPanel } from "./diff-panel";

/**
 * The review surface beside the session: the diff. The project's files are a
 * surface of their own (`files`); the header's Files button opens or focuses
 * it.
 */
export interface ReviewPanelProps {
  tabId: string;
  repoPath: string;
  sessionId?: string | null;
}

export function ReviewPanel({ tabId, repoPath, sessionId = null }: ReviewPanelProps) {
  const files = (
    <Hint label="Files">
      <IconButton size="sm" icon={FolderTree} label="Show files" onClick={() => revealFiles()} />
    </Hint>
  );
  return <DiffPanel tabId={tabId} repoPath={repoPath} sessionId={sessionId} leading={files} />;
}

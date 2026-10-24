// The session context overlay's body.
//
// Reading order: Workspace (where it runs, how to open it), then the
// session's attached projects once that section lands (`ThreadRow.
// attachedProjects`; its place is marked in `MainView`), Version control
// (branch, PR, the git action, changes), a Session group (agent and model,
// usage, capture — a session's context with nowhere better to live), then
// Lineage (the session it branched from, its branches, the agents it
// delegated to).
//
// The same body fills both forms of the card: the popover the header button
// opens, and the docked panel beside a wide chat (`session-context-dock.tsx`).
// Rows the backend cannot answer are left out rather than stubbed.

import { ChevronLeft } from "lucide-react";

import { CapturePopover } from "@/features/capture/components/capture-popover";
import { UsagePopup } from "@/features/chat/components/usage-popup";
import { useSessionUsage } from "@/features/chat/lib/use-session-usage";
import { useChatStore } from "@/features/chat/stores/chat-store";

import type { CaptureState } from "../lib/use-capture-state";
import { useSessionContextStore } from "../stores/session-context-store";
import { LineageSection } from "./lineage-section";
import { SessionSection } from "./session-section";
import { VersionControlSection } from "./version-control-section";
import { WorkspaceSection } from "./workspace-section";

export interface SessionContextBodyProps {
  /** The chat tab whose session this describes; `null` for a non-chat tab,
   *  which shows the project rows only. */
  tabId: string | null;
  /** The project the tab belongs to. */
  projectPath: string | null;
  capture: CaptureState;
}

export function SessionContextBody({ tabId, projectPath, capture }: SessionContextBodyProps) {
  const view = useSessionContextStore.use.view();
  if (view === "capture" && projectPath) {
    return (
      <DrillIn title="Session capture">
        <CapturePopover
          embedded
          projectPath={projectPath}
          health={capture.health}
          onChanged={capture.refresh}
          onClose={() => useSessionContextStore.getState().actions.back()}
        />
      </DrillIn>
    );
  }
  if (view === "usage" && tabId) {
    return (
      <DrillIn title="Usage">
        <UsageView tabId={tabId} />
      </DrillIn>
    );
  }
  return <MainView tabId={tabId} projectPath={projectPath} capture={capture} />;
}

function MainView({ tabId, projectPath, capture }: SessionContextBodyProps) {
  const isChat = useChatStore((s) => (tabId ? !!s.sessions[tabId] : false));
  if (!projectPath && !isChat) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">No project or session here.</p>;
  }
  return (
    <div className="flex flex-col">
      {projectPath && <WorkspaceSection projectPath={projectPath} />}
      {/* The attached projects section goes here, between where the session
          runs and its version control. */}
      {projectPath && <VersionControlSection tabId={tabId} projectPath={projectPath} />}
      <SessionSection tabId={tabId} capture={capture} projectPath={projectPath} />
      {isChat && tabId && <LineageSection tabId={tabId} projectPath={projectPath} />}
    </div>
  );
}

/** Mounted only while shown, so the usage record is fetched only then. */
function UsageView({ tabId }: { tabId: string }) {
  const view = useSessionUsage(tabId, true);
  return <UsagePopup view={view} />;
}

/** A drill-in view: a back row, then the surface. */
function DrillIn({ title, children }: { title: string; children: React.ReactNode }) {
  const back = useSessionContextStore.use.actions().back;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 border-b border-border px-1.5 py-1.5">
        <button
          type="button"
          onClick={back}
          className="flex h-7 cursor-pointer items-center gap-1 rounded-lg px-1.5 text-xs font-medium text-muted-foreground outline-none hover:bg-element-hover hover:text-foreground focus-visible:bg-element-hover"
        >
          <ChevronLeft size={14} aria-hidden />
          Back
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-xs font-medium text-secondary-foreground">
          {title}
        </span>
        {/* Balances the back button so the title centres on the card. */}
        <span className="w-14 shrink-0" aria-hidden />
      </div>
      {children}
    </div>
  );
}

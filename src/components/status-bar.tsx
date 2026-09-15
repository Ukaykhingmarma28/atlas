import { BranchPopover } from "./branch-popover";
import { FeedbackButton } from "@/features/feedback/components/feedback-button";

// The per-session usage widget that used to sit here (tokens · msgs · cost ·
// model) moved into the composer as the Usage pill (chat/components/usage-pill)
// on 2026-09-16 — it belongs beside the session it describes, and it read
// "0 tokens · $0.0000" for every ACP session anyway.
export function StatusBar() {
  return (
    <div
      className="h-7 flex items-center justify-between px-3 shrink-0 bg-[#000] border-t border-border-default text-[11px] font-mono text-[#555] select-none relative"
      style={{ zIndex: "var(--z-max)" as unknown as number }}
    >
      <div className="flex items-center gap-3">
        <BranchPopover />
      </div>
      <div className="flex items-center gap-3">
        <FeedbackButton />
      </div>
    </div>
  );
}

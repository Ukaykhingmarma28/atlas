import { lazy, Suspense } from "react";
import { PanelSkeleton } from "@/components/panel-skeleton";

// Lazy: team chat is never on screen during the boot cascade unless the slot
// was left open.
const CommsPanel = lazy(() =>
  import("@/features/comms/components/comms-panel").then((m) => ({
    default: m.CommsPanel,
  })),
);

/** The right slot: team chat (⌘⇧C). Source control is a surface tab now. */
export function RightPanel() {
  return (
    <Suspense fallback={<PanelSkeleton label="Chat" />}>
      <CommsPanel />
    </Suspense>
  );
}

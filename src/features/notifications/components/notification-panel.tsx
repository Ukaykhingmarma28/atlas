import { lazy, Suspense, useMemo } from "react";
import { Bell, Shield, AlertTriangle, X, Sparkles, BellRing, SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { timeAgo } from "@/lib/time-ago";
import { AtlasIcon } from "@/components/atlas-icon";
// `@lobehub/icons` (~34 KB runtime + 21 glyphs) only matters once a chat-done
// row is on screen; this was its one eager importer, which put it in the boot
// set. The other three consumers already sit behind lazy panels.
const ProviderLogo = lazy(() =>
  import("@/components/provider-logo").then((m) => ({ default: m.ProviderLogo })),
);
import { jumpToSession } from "@/features/chat/lib/tab-project";
import { jumpToTerminal } from "@/features/terminal/lib/jump-to-terminal";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import {
  useNotificationsStore,
  visibleItems,
  type AppNotification,
} from "../stores/notifications-store";

/** Bucket a timestamp into a relative-day group label. */
function dayBucket(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function NotificationPanel() {
  const open = useNotificationsStore.use.panelOpen();
  const allItems = useNotificationsStore.use.items();
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  // Org-scoped view over a global list: switching organisations must not
  // lose the other org's items, only hide them.
  const items = useMemo(() => visibleItems(allItems, activeOrgId), [allItems, activeOrgId]);
  const { close, clearAll } = useNotificationsStore.use.actions();

  // Preserve first-seen order within each day bucket (items are newest-first).
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: AppNotification[] }> = [];
    for (const n of items) {
      const label = dayBucket(n.timestamp);
      const g = out[out.length - 1];
      if (g && g.label === label) g.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  }, [items]);

  if (!open) return null;

  return (
    <>
      {/* Scrim — subtle; the blurred panel carries the depth. */}
      <div
        className="fixed inset-0 z-drawer scrim-soft animate-fade-in"
        onClick={close}
        aria-hidden
      />
      <aside
        className={cn(
          "fixed right-0 top-0 bottom-0 z-drawer w-[360px] flex flex-col",
          "border-l border-[var(--border)]",
          "bg-[var(--card)]/60 backdrop-blur-2xl",
          "shadow-md animate-slide-in-right",
        )}
        role="dialog"
        aria-label="Notifications"
      >
        {/* Header — matches the window titlebar height (30px). */}
        <div className="flex items-center gap-2 px-4 h-[30px] shrink-0 border-b border-[var(--border)]">
          <Bell size={13} className="text-secondary-foreground" strokeWidth={1.5} />
          <span className="text-sm font-semibold text-foreground">Notifications</span>
          <div className="flex-1" />
          {items.length > 0 && (
            <button
              onClick={clearAll}
              className="text-2xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Timeline */}
        <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar">
          {items.length === 0 ? (
            <div className="grid h-full place-items-center px-6">
              <div className="text-center">
                <div className="mx-auto grid h-11 w-11 place-items-center rounded-2xl border border-border-subtle bg-element-hover">
                  <Bell size={18} className="text-muted-foreground" strokeWidth={1.5} />
                </div>
                <p className="mt-3 text-sm text-muted-foreground">No notifications</p>
              </div>
            </div>
          ) : (
            <div className="pb-3">
              {groups.map((g) => (
                <section key={g.label}>
                  <div className="sticky top-0 z-10 px-4 pt-3 pb-1.5 bg-[var(--card)]/40 backdrop-blur-sm text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {g.label}
                  </div>
                  <div className="flex flex-col gap-1.5 px-3">
                    {g.items.map((n) => (
                      <NotificationCard key={n.id} n={n} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function NotificationCard({ n }: { n: AppNotification }) {
  const { dismiss, close } = useNotificationsStore.use.actions();

  const onOpen = () => {
    close();
    focusNotification(n);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className={cn(
        "group relative flex items-start gap-2.5 rounded-xl border border-border-subtle px-3 py-2.5",
        "bg-element-hover hover:bg-element-selected transition-colors cursor-pointer select-none",
      )}
    >
      <span className="mt-0.5 shrink-0">
        <NotificationIcon n={n} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {!n.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--primary)]" />}
          <span className="truncate text-sm font-medium text-foreground">{n.title}</span>
          <span className="ml-auto shrink-0 text-3xs text-muted-foreground tabular-nums">
            {timeAgo(n.timestamp, { suffix: true })}
          </span>
        </div>
        {n.body && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-secondary-foreground">
            {n.body}
          </p>
        )}
      </div>

      <Hint label="Dismiss">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            dismiss(n.id);
          }}
          className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 grid h-5 w-5 place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-element-active transition-opacity"
        >
          <X size={11} />
        </button>
      </Hint>
    </div>
  );
}

function NotificationIcon({ n }: { n: AppNotification }) {
  if (n.kind === "permission")
    return <Shield size={15} className="text-primary" strokeWidth={1.5} />;
  if (n.kind === "agent-failed" || n.kind === "chat-error" || n.kind === "terminal-failed")
    return (
      <AlertTriangle
        size={15}
        className="text-[var(--atlas-status-error-foreground)]"
        strokeWidth={1.5}
      />
    );
  if (n.kind === "terminal-attention")
    return (
      <BellRing
        size={15}
        className="text-[var(--atlas-status-warning-foreground)]"
        strokeWidth={1.5}
      />
    );
  if (n.kind === "terminal-done")
    return <SquareTerminal size={15} className="text-secondary-foreground" strokeWidth={1.5} />;
  if (n.kind === "chat-done" && n.provider)
    return (
      // 22 = size + 6, the box ProviderLogo renders, so the row never shifts.
      <Suspense fallback={<span className="shrink-0" style={{ width: 22, height: 22 }} />}>
        <ProviderLogo id={n.provider} size={16} />
      </Suspense>
    );
  if (n.source === "agent") return <AtlasIcon size={16} className="rounded-md" />;
  return <Sparkles size={15} className="text-secondary-foreground" strokeWidth={1.5} />;
}

/** Best-effort: bring the originating chat or terminal into view. */
function focusNotification(n: AppNotification) {
  if (n.source === "terminal" && n.tabId) {
    void jumpToTerminal({ tabId: n.tabId, terminalId: n.terminalId, projectId: n.projectId });
    return;
  }
  if (n.source === "agent" && n.tabId) {
    // Project-aware: a bare setActiveTab on a tab from ANOTHER project
    // falls back to tabs[0] of the current one — jumpToSession switches to the
    // owning project first.
    void jumpToSession(n.tabId);
    return;
  }
}

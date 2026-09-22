/**
 * The project rail's "+" — Open Folder plus a searchable list of recent
 * projects, adding the chosen one to the sidebar.
 *
 * Its own file because two surfaces render it: the rail's org row (its home,
 * beside the ⌘K search button) and, historically, the titlebar band. Keeping
 * it in `project-sidebar.tsx` would have made `org-switcher.tsx` import from
 * the very module that renders `<OrgSwitcher/>` — a cycle.
 */
import { useMemo, useState } from "react";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { Folder, FolderOpen, Plus, Search, Trash2 } from "lucide-react";
import { useAppStore } from "@/features/app/stores/app-store";
import { recentsForOrg } from "@/features/app/lib/recent-projects";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useProjectStore } from "../stores/project-store";
import { pickAndAddProject } from "../lib/pick-project";
import { Hint } from "@/ui/tooltip";

export function AddProjectMenu() {
  const { addProject } = useProjectStore.use.actions();
  const allRecents = useAppStore.use.recentProjects();
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  const projects = useProjectStore.use.projects();
  // Scoped to the active org — see `recentsForOrg`.
  const recentProjects = useMemo(
    () => recentsForOrg(allRecents, projects, activeOrgId),
    [allRecents, projects, activeOrgId],
  );
  const { clearRecents } = useAppStore.use.actions();
  const [query, setQuery] = useState("");
  const filtered = recentProjects.filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.path.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <DropdownMenu.Root
      onOpenChange={(o) => {
        if (!o) setQuery("");
      }}
    >
      <Hint label="Add project">
        <DropdownMenu.Trigger
          render={
            <button
              className="flex size-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] outline-none transition-colors cursor-pointer"
              aria-label="Add project"
            >
              <Plus size={14} />
            </button>
          }
        />
      </Hint>
      <DropdownMenu.Portal>
        {/* Compact menu primitive — mirrors the source-control "filter files"
         *  dropdown: 26px rows, px-3 on both sides, border-b search header. */}
        <DropdownMenu.Positioner className="z-popover" align="end" sideOffset={4}>
          <DropdownMenu.Popup className="w-[280px] max-h-[360px] rounded-lg border border-[var(--border)] bg-popover shadow-xl text-[var(--secondary-foreground)] flex flex-col overflow-hidden">
            <DropdownMenu.Item
              onClick={() => void pickAndAddProject()}
              className="w-full flex items-center gap-2 px-3 h-[28px] text-xs outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-default shrink-0"
            >
              <FolderOpen size={13} className="text-[var(--muted-foreground)] shrink-0" />
              <span className="flex-1 text-left">Open Folder…</span>
            </DropdownMenu.Item>
            {recentProjects.length > 0 && (
              <>
                <div
                  className="flex items-center gap-1.5 px-3 h-[30px] border-y border-[var(--border)] shrink-0"
                  onKeyDown={(e) => {
                    // Keep keys from the popup's typeahead and arrow nav, but let Escape
                    // bubble to the dismiss handler so it still closes the popup.
                    if (e.key !== "Escape") e.stopPropagation();
                  }}
                >
                  <Search size={11} className="text-[var(--muted-foreground)] shrink-0" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search projects…"
                    className="flex-1 bg-transparent outline-none text-2xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
                  />
                </div>
                <div className="px-3 pt-1.5 pb-0.5 text-3xs uppercase tracking-wide text-[var(--muted-foreground)] shrink-0">
                  Recent
                </div>
                <div className="overflow-y-auto py-1 hide-scrollbar">
                  {filtered.length === 0 ? (
                    <div className="px-3 py-2 text-2xs text-[var(--muted-foreground)] text-center">
                      No matches
                    </div>
                  ) : (
                    filtered.map((p) => (
                      <DropdownMenu.Item
                        key={p.path}
                        onClick={() => void addProject(p.path)}
                        className="w-full flex items-center gap-2 px-3 h-control-md text-xs outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-default"
                      >
                        <Folder size={12} className="text-[var(--muted-foreground)] shrink-0" />
                        <span className="truncate font-mono text-left flex-1">{p.name}</span>
                      </DropdownMenu.Item>
                    ))
                  )}
                </div>
                <DropdownMenu.Item
                  onClick={() => clearRecents()}
                  className="w-full flex items-center gap-2 px-3 h-[28px] text-xs outline-none border-t border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-error cursor-pointer shrink-0"
                >
                  <Trash2 size={12} className="shrink-0" />
                  <span className="flex-1 text-left">Clear recent projects</span>
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

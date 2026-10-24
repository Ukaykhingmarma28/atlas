// The list's header: search across every session, then the project filter,
// add project, and new session.
//
// The search is a combobox over the list below it: typing swaps the sections
// for results, the arrow keys move a highlight through them (the field keeps
// focus), Enter opens the highlighted one and Escape clears. The project
// filter narrows the list to one project and is remembered across restarts;
// each project in it carries a shortcut to its settings.

import { useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { Download, Folder, ListFilter, Search, Settings, SquarePen, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { AddProjectMenu } from "@/features/projects/components/add-project-menu";
import type { SidebarProject } from "../lib/sidebar-sessions";
import { ProjectBadge } from "./session-row-parts";

export const SEARCH_RESULTS_ID = "sidebar-session-search-results";
export const searchResultId = (index: number) => `sidebar-session-search-result-${index}`;

export interface SidebarSessionHeaderProps {
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
  projects: readonly SidebarProject[];
  scopeProjectId: string | null;
  onScopeChange: (projectId: string | null) => void;
  onProjectSettings: (project: SidebarProject) => void;
  /** Pull in sessions an agent kept for itself (the import dialog). */
  onImportSessions: () => void;
  onNewSession: () => void;
  newSessionDisabled: boolean;
  newSessionShortcut: string | null;
}

export function SidebarSessionHeader(props: SidebarSessionHeaderProps) {
  const {
    searchInputRef,
    searchQuery,
    onSearchQueryChange,
    onSearchKeyDown,
    isSearching,
    searchResultCount,
    activeSearchResultIndex,
    onClearSearch,
  } = props;
  const resultsVisible = isSearching && searchResultCount > 0;
  // Results shrink as the query narrows, so the active index can outrun the
  // list; pointing aria-activedescendant at a removed option strands the
  // screen reader on nothing.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  return (
    <div className="flex items-center gap-1 px-2">
      <label className="flex h-7 min-w-0 flex-1 cursor-text items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-element-hover hover:text-foreground focus-within:bg-element-hover">
        <Search aria-hidden className="size-3.5 shrink-0" />
        <input
          ref={searchInputRef}
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search sessions"
          aria-label="Search sessions"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={resultsVisible}
          aria-controls={resultsVisible ? SEARCH_RESULTS_ID : undefined}
          aria-activedescendant={
            activeResultExists ? searchResultId(activeSearchResultIndex) : undefined
          }
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        {isSearching ? (
          <button
            type="button"
            aria-label="Clear session search"
            onClick={() => {
              onClearSearch();
              searchInputRef.current?.focus();
            }}
            className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          >
            <X aria-hidden className="size-3" />
          </button>
        ) : null}
      </label>
      <div className="flex shrink-0 items-center">
        {props.projects.length > 0 ? (
          <ProjectScopeMenu
            projects={props.projects}
            scopeProjectId={props.scopeProjectId}
            onScopeChange={props.onScopeChange}
            onProjectSettings={props.onProjectSettings}
            onImportSessions={props.onImportSessions}
          />
        ) : null}
        <AddProjectMenu />
        <HeaderIconButton
          label={
            props.newSessionShortcut ? `New session ${props.newSessionShortcut}` : "New session"
          }
          disabled={props.newSessionDisabled}
          onClick={props.onNewSession}
        >
          <SquarePen aria-hidden className="size-3.5" />
        </HeaderIconButton>
      </div>
    </div>
  );
}

function HeaderIconButton({
  label,
  children,
  disabled,
  onClick,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Hint label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-element-hover hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        {children}
      </button>
    </Hint>
  );
}

/** "Filter by project": every project in the organisation, searchable, plus
 *  "All projects". The trigger wears the scoped project's badge. */
function ProjectScopeMenu({
  projects,
  scopeProjectId,
  onScopeChange,
  onProjectSettings,
  onImportSessions,
}: {
  projects: readonly SidebarProject[];
  scopeProjectId: string | null;
  onScopeChange: (projectId: string | null) => void;
  onProjectSettings: (project: SidebarProject) => void;
  onImportSessions: () => void;
}) {
  const [query, setQuery] = useState("");
  const scoped = projects.find((project) => project.id === scopeProjectId) ?? null;
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? projects.filter((project) => project.name.toLowerCase().includes(needle))
    : projects;
  const label = scoped
    ? `Filter sessions by project: ${scoped.name}`
    : "Filter sessions by project";
  const itemClassName =
    "flex h-control-md w-full cursor-pointer items-center gap-2 rounded px-2 text-xs text-secondary-foreground outline-none data-highlighted:bg-element-hover data-highlighted:text-foreground";
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <Hint label={label}>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              aria-label={label}
              className={cn(
                "flex size-6 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-element-hover hover:text-foreground",
                scoped ? "text-foreground" : "text-muted-foreground",
              )}
            />
          }
        >
          {scoped ? (
            <ProjectBadge name={scoped.name} />
          ) : (
            <ListFilter aria-hidden className="size-3.5" />
          )}
        </DropdownMenu.Trigger>
      </Hint>
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" align="start" sideOffset={4}>
          <DropdownMenu.Popup className="flex max-h-96 w-64 flex-col overflow-hidden rounded-lg border border-border bg-popover text-foreground shadow-md outline-none origin-[var(--transform-origin)] animate-scale-in">
            <div
              className="flex h-control-lg shrink-0 items-center gap-1.5 border-b border-border px-2.5"
              onKeyDown={(event) => {
                // Keep keys from the popup's typeahead and arrow nav, but let
                // Escape bubble to the dismiss handler so it still closes.
                if (event.key !== "Escape") event.stopPropagation();
              }}
            >
              <Search aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects…"
                aria-label="Search projects"
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="hide-scrollbar overflow-y-auto p-0.5">
              {needle ? null : (
                <DropdownMenu.Item
                  onClick={() => onScopeChange(null)}
                  className={cn(itemClassName, scoped === null && "text-foreground")}
                >
                  <Folder aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">All projects</span>
                </DropdownMenu.Item>
              )}
              {filtered.length === 0 ? (
                <div className="px-2 py-2 text-center text-2xs text-muted-foreground">
                  No matching projects.
                </div>
              ) : (
                filtered.map((project) => (
                  <DropdownMenu.Item
                    key={project.id}
                    onClick={() => onScopeChange(project.id)}
                    className={cn(
                      itemClassName,
                      "group/scope-item",
                      project.id === scopeProjectId && "text-foreground",
                    )}
                  >
                    <ProjectBadge name={project.name} />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Project settings for ${project.name}`}
                      title={`Project settings for ${project.name}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onProjectSettings(project);
                      }}
                      className="ml-auto inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:text-foreground group-hover/scope-item:opacity-100 group-data-highlighted/scope-item:opacity-100"
                    >
                      <Settings aria-hidden className="size-3.5" />
                    </button>
                  </DropdownMenu.Item>
                ))
              )}
            </div>
            <div className="shrink-0 border-t border-border p-0.5">
              <DropdownMenu.Item onClick={onImportSessions} className={itemClassName}>
                <Download aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">Import sessions from agents…</span>
              </DropdownMenu.Item>
            </div>
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// A repository's pull requests, as a surface tab (`pull-requests:<checkout>`):
// search, state, involvement, sort and filters over the host's listing,
// grouped as Authored / Review requested / Others, a page at a time and
// virtualized. A row opens the pull request in its own tab.
//
// The host does the heavy narrowing (state, involvement, search, author,
// draft, labels); review and checks are narrowed here, over what has loaded.
// How the list was left is remembered per viewer
// (`pull-request-list-preferences.ts`); the search is not.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Eye, GitPullRequest, Layers, PenLine, RefreshCw, Search, Users, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";

import { openPullRequestTab } from "../lib/open-pull-request-tab";
import { classifyPrError } from "../lib/pr-errors";
import {
  collectPullRequestListFacets,
  groupPullRequestsByInvolvement,
  hasLocalFilters,
  matchesPullRequestFilters,
  MATCHED_ELSEWHERE_SCORE,
  rankPullRequestMatches,
  scorePullRequestMatch,
  sortPullRequestGroups,
  type PullRequestGroup,
  type PullRequestGroupKey,
} from "../lib/pull-request-list-logic";
import {
  readPullRequestListPreferences,
  writePullRequestListPreferences,
  type PullRequestListPreferences,
} from "../lib/pull-request-list-preferences";
import { usePrListPages, usePrProvider } from "../lib/pull-requests-queries";
import type { PrListEntry } from "../lib/pull-requests-types";
import { useAutoNextPage } from "../lib/use-auto-next-page";
import { PullRequestScopeContext } from "./pull-request-context";
import {
  CompactFilterMenu,
  INVOLVEMENT_OPTIONS,
  PullRequestFiltersMenu,
  SORT_OPTIONS,
  STATE_OPTIONS,
} from "./pull-request-list-filters";
import { PULL_REQUEST_ROW_HEIGHT, PullRequestListRow } from "./pull-request-list-row";
import { PullRequestListGhost, PullRequestsUnavailableState } from "./pull-request-states";

/** Rows the host is asked for per page. */
const PAGE = 50;
/** Within this many rows of the end, the next page is asked for. */
const PREFETCH_ROWS = 8;
/** With a review or checks filter on, the pages read without asking: past
 *  this, a filter that matches little would page through the whole
 *  repository on its own, so the reader asks for more instead. */
export const AUTO_PAGES_WHILE_FILTERED = 3;
const GROUP_HEADER_HEIGHT = 28;
const SEARCH_DEBOUNCE_MS = 300;

const GROUP_ICONS: Record<PullRequestGroupKey, typeof Layers> = {
  authored: PenLine,
  reviewRequested: Eye,
  others: Users,
};

type Item =
  | { kind: "header"; group: PullRequestGroup }
  | { kind: "row"; entry: PrListEntry }
  | { kind: "more" };

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function PullRequestListPanel({ repoPath }: { repoPath: string }) {
  const [prefs, setPrefs] = useState<PullRequestListPreferences>(readPullRequestListPreferences);
  const update = useCallback((next: Partial<PullRequestListPreferences>) => {
    setPrefs((current) => {
      const merged = { ...current, ...next };
      writePullRequestListPreferences(merged);
      return merged;
    });
  }, []);
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);

  const provider = usePrProvider(repoPath);
  const viewer = provider.data?.viewer ?? null;
  const { filters } = prefs;
  const list = usePrListPages(repoPath, {
    state: prefs.state,
    involvement: prefs.involvement,
    search: query || null,
    author: filters.author ?? null,
    draft: filters.draft ?? null,
    labels: filters.labels?.length ? filters.labels : null,
    limit: PAGE,
  });

  const loaded = useMemo(() => {
    const seen = new Set<number>();
    const rows: PrListEntry[] = [];
    for (const page of list.data?.pages ?? []) {
      for (const entry of page.entries) {
        if (seen.has(entry.number)) continue;
        seen.add(entry.number);
        rows.push(entry);
      }
    }
    return rows;
  }, [list.data]);

  const facets = useMemo(
    () => collectPullRequestListFacets(loaded, prefs.state),
    [loaded, prefs.state],
  );

  const groups = useMemo(() => {
    const narrowed = hasLocalFilters(filters)
      ? loaded.filter((entry) => matchesPullRequestFilters(entry, filters, viewer))
      : loaded;
    const ordered = query ? rankPullRequestMatches(narrowed, query) : narrowed;
    const grouped =
      prefs.involvement === "all"
        ? groupPullRequestsByInvolvement(ordered, viewer)
        : ordered.length > 0
          ? [{ key: "others" as const, label: "", entries: ordered }]
          : [];
    return sortPullRequestGroups(grouped, prefs.sort, query);
  }, [loaded, filters, viewer, query, prefs.involvement, prefs.sort]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const group of groups) {
      if (group.label) out.push({ kind: "header", group });
      for (const entry of group.entries) out.push({ kind: "row", entry });
    }
    if (out.length > 0 && list.hasNextPage) out.push({ kind: "more" });
    return out;
  }, [groups, list.hasNextPage]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (index) =>
      items[index]?.kind === "header" ? GROUP_HEADER_HEIGHT : PULL_REQUEST_ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => {
      const item = items[index];
      if (!item) return index;
      return item.kind === "row"
        ? `row:${item.entry.number}`
        : item.kind === "header"
          ? `header:${item.group.key}`
          : "more";
    },
  });

  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = list;
  const pagesLoaded = list.data?.pages.length ?? 0;
  // Review and checks narrow only what has loaded (the host narrows the
  // rest), so a sparse match keeps the end of the list in view and would
  // page on forever: cap it.
  const narrowsLoaded = filters.review !== undefined || filters.checks !== undefined;
  const autoPagingCapped = narrowsLoaded && pagesLoaded >= AUTO_PAGES_WHILE_FILTERED;
  useAutoNextPage(list, !autoPagingCapped && lastIndex >= items.length - PREFETCH_ROWS);
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);

  // Back to the top when what is asked for changes.
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [prefs.state, prefs.involvement, prefs.sort, query, filters]);

  const open = useCallback(
    (entry: PrListEntry) =>
      openPullRequestTab({ repoPath, number: entry.number, title: entry.title }),
    [repoPath],
  );

  const refreshing = list.isRefetching && !isFetchingNextPage;
  const refresh = () => {
    void provider.refetch();
    void list.refetch();
  };
  const error = list.error ?? (list.data ? null : provider.error);
  const scope = useMemo(() => ({ repoPath, number: 0, repositoryUrl: null }), [repoPath]);
  const searching = search.trim() !== query || (list.isFetching && !!query && !list.data);

  return (
    <PullRequestScopeContext.Provider value={scope}>
      <div className="@container/pr-list flex h-full min-h-0 min-w-0 flex-col bg-background">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <GitPullRequest aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <h1 className="shrink-0 text-xs font-medium text-foreground">Pull requests</h1>
          {provider.data ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {provider.data.repository}
            </span>
          ) : null}
          <span className="ml-auto" />
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh pull requests"
            title="Refresh pull requests"
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshCw aria-hidden className={cn("size-3.5", refreshing && "animate-spin")} />
          </Button>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
          <label className="flex h-control-md min-w-40 flex-1 cursor-text items-center gap-1.5 rounded border border-border bg-panel-input px-2 focus-within:border-border-strong">
            <Search aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && search) {
                  event.preventDefault();
                  setSearch("");
                }
              }}
              placeholder="Search pull requests"
              aria-label="Search pull requests"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
            {search ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearch("")}
                className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
              >
                <X aria-hidden className="size-3" />
              </button>
            ) : null}
          </label>
          <CompactFilterMenu
            label="State"
            value={prefs.state}
            options={STATE_OPTIONS}
            onChange={(state) => update({ state })}
          />
          <CompactFilterMenu
            label="Involvement"
            value={prefs.involvement}
            options={INVOLVEMENT_OPTIONS}
            onChange={(involvement) => update({ involvement })}
            iconOnly
          />
          <CompactFilterMenu
            label="Sort"
            value={prefs.sort}
            options={SORT_OPTIONS}
            onChange={(sort) => update({ sort })}
            iconOnly
          />
          <PullRequestFiltersMenu
            filters={filters}
            onFilters={(next) => update({ filters: next })}
            authors={facets.authors}
            labels={facets.labels}
          />
        </div>
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
          {error && loaded.length === 0 ? (
            <PullRequestsUnavailableState
              error={classifyPrError(error)}
              retrying={list.isFetching || provider.isFetching}
              onRetry={refresh}
            />
          ) : list.isLoading || (searching && loaded.length === 0) ? (
            <PullRequestListGhost
              caption={query ? `Searching for “${truncate(query)}”` : undefined}
            />
          ) : items.length === 0 ? (
            <PullRequestListEmptyState
              query={query}
              filtered={
                hasLocalFilters(filters) || prefs.state !== "open" || prefs.involvement !== "all"
              }
              loadingMore={isFetchingNextPage}
              canLoadMore={!!hasNextPage}
              refreshing={refreshing}
              onClearQuery={() => setSearch("")}
              onClearFilters={() => update({ filters: {}, state: "open", involvement: "all" })}
              loadFailed={isFetchNextPageError}
              onLoadMore={loadMore}
              onRefresh={refresh}
            />
          ) : (
            <div
              role="list"
              aria-label="Pull requests"
              className="relative mx-1 my-1"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualItems.map((virtual) => {
                const item = items[virtual.index];
                if (!item) return null;
                return (
                  <div
                    key={virtual.key}
                    role={item.kind === "row" ? "listitem" : undefined}
                    className="absolute top-0 left-0 w-full"
                    style={{
                      height: virtual.size,
                      transform: `translateY(${virtual.start}px)`,
                    }}
                  >
                    {item.kind === "header" ? (
                      <GroupHeader group={item.group} />
                    ) : item.kind === "row" ? (
                      <PullRequestListRow
                        entry={item.entry}
                        matchedElsewhere={
                          !!query &&
                          scorePullRequestMatch(item.entry, query) <= MATCHED_ELSEWHERE_SCORE
                        }
                        onOpen={open}
                      />
                    ) : (
                      <MoreRow
                        loading={isFetchingNextPage}
                        failed={isFetchNextPageError}
                        capped={autoPagingCapped}
                        onLoad={loadMore}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </PullRequestScopeContext.Provider>
  );
}

/** The list's last row while more pages exist: what the next read is doing,
 *  or the button that asks for it when it is not asked for on its own. */
function MoreRow({
  loading,
  failed,
  capped,
  onLoad,
}: {
  loading: boolean;
  failed: boolean;
  capped: boolean;
  onLoad: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-2xs text-muted-foreground">
      {loading ? (
        "Loading more pull requests…"
      ) : failed ? (
        <>
          <span>More pull requests could not be loaded.</span>
          <Button size="xs" variant="outline" onClick={onLoad}>
            Retry
          </Button>
        </>
      ) : capped ? (
        <Button size="xs" variant="ghost" onClick={onLoad}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}

const truncate = (text: string) => (text.length > 48 ? `${text.slice(0, 48)}…` : text);

function GroupHeader({ group }: { group: PullRequestGroup }) {
  const Icon = GROUP_ICONS[group.key];
  return (
    <div className="flex h-full items-end gap-2 px-2 pb-1 text-2xs font-medium text-muted-foreground">
      <Icon aria-hidden className="size-3 shrink-0" />
      <h2 className="shrink-0">{group.label}</h2>
      <span className="shrink-0 tabular-nums text-disabled">{group.entries.length}</span>
      <span aria-hidden className="mb-1.5 h-px min-w-2 flex-1 bg-border-subtle" />
    </div>
  );
}

/** Two branches that have not met yet: the list's empty mark. */
function BranchMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 120 72"
      className="h-14 w-24 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 58h100" strokeOpacity={0.4} />
      <circle cx="10" cy="58" r="5" fill="currentColor" fillOpacity={0.25} />
      <circle cx="110" cy="58" r="5" fill="currentColor" fillOpacity={0.25} />
      <path d="M30 58c0-18 8-26 24-26h4" />
      <path d="M90 58c0-18-8-26-24-26h-4" strokeDasharray="2 7" strokeOpacity={0.6} />
      <circle cx="60" cy="32" r="4" strokeOpacity={0.6} />
    </svg>
  );
}

function PullRequestListEmptyState({
  query,
  filtered,
  canLoadMore,
  loadingMore,
  loadFailed,
  refreshing,
  onClearQuery,
  onClearFilters,
  onLoadMore,
  onRefresh,
}: {
  query: string;
  filtered: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  loadFailed: boolean;
  refreshing: boolean;
  onClearQuery: () => void;
  onClearFilters: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}) {
  const title = query
    ? `Nothing matches “${truncate(query)}”`
    : filtered
      ? "Nothing under these filters"
      : "No open pull requests";
  const description = query
    ? "GitHub was searched for it, bodies included. Try fewer words, or a number, author or branch."
    : filtered
      ? "Widen the state, involvement or filters to see more."
      : "When someone opens a pull request in this repository, it shows up here.";
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <BranchMark />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {query ? (
          <Button size="sm" variant="outline" onClick={onClearQuery}>
            <X aria-hidden className="size-3.5" />
            Clear search
          </Button>
        ) : filtered ? (
          <Button size="sm" variant="outline" onClick={onClearFilters}>
            <X aria-hidden className="size-3.5" />
            Clear filters
          </Button>
        ) : null}
        {canLoadMore ? (
          <Button size="sm" variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Loading…" : loadFailed ? "Retry loading more" : "Load more"}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw aria-hidden className={cn("size-3.5", refreshing && "animate-spin")} />
          {refreshing ? "Checking…" : "Check again"}
        </Button>
      </div>
    </div>
  );
}

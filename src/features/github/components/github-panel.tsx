import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as Popover from "@radix-ui/react-popover";
import { useProjectStore } from "@/features/project/stores/project-store";
import {
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  GitBranch,
  GitFork,
  Loader2,
  RefreshCw,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { cn } from "@/lib/utils";
import { logEvent } from "@/features/log/lib/log";
import { toast } from "sonner";
import { metaFromSearch, type ClonedRepo, type GithubRepo } from "@/features/github/types";

/**
 * The GitHub panel: search public repositories, clone them as reference
 * material under `<project>/.atlas/repos/`, and manage what is already
 * there — the checked-out branch, a fetch to the remote's tip, delete.
 *
 * The cloned list is the panel's resting state; searching replaces it with
 * results until the box is cleared. Clones are shallow and single-branch, so
 * "branches" is a live `ls-remote` (asked only when the picker opens) and
 * switching is a shallow fetch of just that branch. Each clone shows the
 * description, language and counts the search result knew at clone time
 * (cached by Rust beside `repos/`, never inside the clone); older clones
 * that predate the cache are filled in once, on demand.
 */

/** One cell of the row's action pill — the same 24px dock as the titlebar's
 *  (`titlebar-dock.tsx`): a `#121212` pill with a hairline, 20px round cells. */
const GROUP_BUTTON =
  "flex size-5 items-center justify-center rounded-full text-text-tertiary hover:text-text-primary hover:bg-bg-active cursor-pointer disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";
const GROUP = "flex items-center gap-px rounded-full border border-white/[0.07] bg-[#121212] p-0.5";

/** Top/bottom edge fades on a scroll container, only while there is more to scroll. */
function useScrollEdges(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const top = el.scrollTop > 2;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
      setEdges((cur) => (cur.top === top && cur.bottom === bottom ? cur : { top, bottom }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return edges;
}

function ScrollFade({ at, visible }: { at: "top" | "bottom"; visible: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        // The right panel paints `--panel-bg-2`, not `--bg-primary`; fading
        // from the wrong colour was a faint grey wash over black, invisible.
        "pointer-events-none absolute inset-x-0 z-10 h-14 transition-opacity duration-200",
        at === "top"
          ? "top-0 bg-gradient-to-b from-[var(--panel-bg-2)] via-[var(--panel-bg-2)]/80 to-transparent"
          : "bottom-0 bg-gradient-to-t from-[var(--panel-bg-2)] via-[var(--panel-bg-2)]/80 to-transparent",
        visible ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/** Branch picker: a popover with a filter box over origin's branches. */
function BranchPicker({
  repo,
  projectPath,
  busy,
  onSwitch,
}: {
  repo: ClonedRepo;
  projectPath: string;
  busy: boolean;
  onSwitch: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!open || branches) return;
    let cancelled = false;
    setError(null);
    invoke<string[]>("list_remote_branches", { projectPath, repoName: repo.name })
      .then((list) => {
        if (!cancelled) setBranches(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, branches, projectPath, repo.name]);

  const shown = useMemo(() => {
    if (!branches) return [];
    const q = filter.trim().toLowerCase();
    const list = q ? branches.filter((b) => b.toLowerCase().includes(q)) : branches;
    // The checked-out branch first, so it is never buried under a long list.
    return repo.branch && list.includes(repo.branch)
      ? [repo.branch, ...list.filter((b) => b !== repo.branch)]
      : list;
  }, [branches, filter, repo.branch]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setFilter("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={busy}
          className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-primary cursor-pointer disabled:cursor-default"
          title="Switch to another remote branch"
        >
          <GitBranch size={9} />
          <span className="truncate max-w-[140px]">{repo.branch ?? "detached"}</span>
          <ChevronDown size={9} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="atlas-menu-pop z-[9999] w-[260px] overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)]"
          onOpenAutoFocus={(e) => {
            // Land in the filter box, not on the first row.
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector("input")?.focus();
          }}
        >
          <div className="flex items-center gap-1.5 h-[30px] px-2.5 border-b border-[var(--border-default)]">
            <Search size={10} className="shrink-0 text-text-tertiary" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) onSwitch(shown[0]);
              }}
              placeholder="Filter branches"
              className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary"
            />
            {branches ? (
              <span className="text-[9px] tabular-nums text-text-tertiary">{shown.length}</span>
            ) : null}
          </div>
          <div className="max-h-[260px] overflow-y-auto hide-scrollbar py-1">
            {error ? (
              <div className="px-3 py-1.5 text-[10px] text-error">{error}</div>
            ) : !branches ? (
              <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] text-text-tertiary">
                <Loader2 size={10} className="animate-spin" /> Fetching branches
              </div>
            ) : shown.length === 0 ? (
              <div className="px-3 py-1.5 text-[10px] text-text-tertiary">
                {filter ? "No branch matches" : "No branches"}
              </div>
            ) : (
              shown.map((b) => {
                const current = b === repo.branch;
                return (
                  <button
                    key={b}
                    type="button"
                    role="option"
                    aria-selected={current}
                    onClick={() => {
                      setOpen(false);
                      if (!current) onSwitch(b);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 h-[26px] text-[11px] text-left cursor-pointer outline-none",
                      current
                        ? "text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--bg-hover)]",
                    )}
                  >
                    <span className="truncate flex-1">{b}</span>
                    {current ? <Check size={11} className="text-[var(--accent-primary)]" /> : null}
                  </button>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** One cloned repo: name, description, counts, branch picker, update, open, delete. */
function ClonedRow({
  repo,
  projectPath,
  onChanged,
}: {
  repo: ClonedRepo;
  projectPath: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"switch" | "update" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const meta = repo.meta;

  const switchBranch = async (branch: string) => {
    if (busy) return;
    setBusy("switch");
    try {
      await invoke("switch_cloned_repo_branch", { projectPath, repoName: repo.name, branch });
      toast.success(`${repo.display_name} is on ${branch}`);
      onChanged();
    } catch (e) {
      toast.error(`Could not switch branch: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const update = async () => {
    if (busy) return;
    setBusy("update");
    try {
      const branch = await invoke<string>("update_cloned_repo", {
        projectPath,
        repoName: repo.name,
      });
      toast.success(`${repo.display_name} updated to origin/${branch}`);
      onChanged();
    } catch (e) {
      toast.error(`Could not fetch: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy("delete");
    try {
      await invoke("delete_cloned_repo", { projectPath, repoName: repo.name });
      window.dispatchEvent(new Event("atlas:repo-cloned"));
      onChanged();
    } catch (e) {
      toast.error(`Could not delete: ${String(e)}`);
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  const openOnGithub = async () => {
    const url = meta?.html_url || `https://github.com/${repo.display_name}`;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  return (
    <div
      data-testid="cloned-repo"
      className="px-3 py-3 border-b border-border-default hover:bg-bg-hover group"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[9.5px] font-medium text-text-primary truncate">
            {repo.display_name}
          </div>
          {meta?.description ? (
            <p className="text-[10px] leading-snug text-text-tertiary mt-1 line-clamp-2">
              {meta.description}
            </p>
          ) : null}
          <div className="flex items-center gap-3 mt-2">
            {busy === "switch" ? (
              <span className="flex items-center gap-1 text-[10px] text-text-tertiary">
                <Loader2 size={9} className="animate-spin" /> Switching…
              </span>
            ) : (
              <BranchPicker
                repo={repo}
                projectPath={projectPath}
                busy={busy !== null}
                onSwitch={(b) => void switchBranch(b)}
              />
            )}
            {meta?.language ? (
              <span className="text-[9px] text-text-tertiary">{meta.language}</span>
            ) : null}
            {meta ? (
              <>
                <span className="flex items-center gap-0.5 text-[9px] text-text-tertiary">
                  <Star size={8} /> {meta.stars.toLocaleString()}
                </span>
                <span className="flex items-center gap-0.5 text-[9px] text-text-tertiary">
                  <GitFork size={8} /> {meta.forks.toLocaleString()}
                </span>
              </>
            ) : null}
          </div>
        </div>

        <div className={cn(GROUP, "shrink-0")}>
          <button
            type="button"
            onClick={() => void update()}
            disabled={busy !== null || !repo.branch}
            className={GROUP_BUTTON}
            title={repo.branch ? `Fetch origin/${repo.branch}` : "Pick a branch to fetch"}
          >
            {busy === "update" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <RefreshCw size={10} />
            )}
          </button>
          <button
            type="button"
            onClick={() => void openOnGithub()}
            className={GROUP_BUTTON}
            title="Open on GitHub"
          >
            <ExternalLink size={10} />
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            onBlur={() => setConfirmDelete(false)}
            disabled={busy !== null}
            className={cn(GROUP_BUTTON, confirmDelete && "text-error hover:text-error")}
            title={confirmDelete ? "Click again to delete the clone" : "Delete clone"}
          >
            {busy === "delete" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Trash2 size={10} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** How many pre-cache clones to ask GitHub about at once. */
const META_BACKFILL_CONCURRENCY = 3;

export function GithubPanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GithubRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState<Set<string>>(new Set());
  const [cloned, setCloned] = useState<Set<string>>(new Set());
  const currentProject = useProjectStore.use.currentProject();
  const projectPath = currentProject?.path ?? null;

  // ── What is already on disk ───────────────────────────────────────────
  const [repos, setRepos] = useState<ClonedRepo[]>([]);
  const refreshRepos = useCallback(async () => {
    if (!projectPath) {
      setRepos([]);
      return;
    }
    try {
      setRepos(await invoke<ClonedRepo[]>("list_cloned_repos", { projectPath }));
    } catch {
      setRepos([]);
    }
  }, [projectPath]);

  useEffect(() => {
    void refreshRepos();
    // The composer's "Add from GitHub" and the Knowledge sidebar clone and
    // delete too; they announce it the same way.
    const onChanged = () => void refreshRepos();
    window.addEventListener("atlas:repo-cloned", onChanged);
    return () => window.removeEventListener("atlas:repo-cloned", onChanged);
  }, [refreshRepos]);

  // Clones made before Atlas cached metadata get theirs filled in once, a
  // few at a time so a long list does not fire thirty requests at GitHub.
  const backfilled = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!projectPath) return;
    const missing = repos.filter((r) => !r.meta && !backfilled.current.has(r.name));
    if (missing.length === 0) return;
    let cancelled = false;
    const queue = missing.slice();
    const worker = async () => {
      for (let r = queue.shift(); r && !cancelled; r = queue.shift()) {
        backfilled.current.add(r.name);
        try {
          const meta = await invoke<ClonedRepo["meta"]>("fetch_cloned_repo_meta", {
            projectPath,
            repoName: r.name,
          });
          if (cancelled) return;
          setRepos((cur) => cur.map((x) => (x.name === r!.name ? { ...x, meta } : x)));
        } catch {
          // Rate-limited or offline: the row simply stays without a blurb.
        }
      }
    };
    for (let i = 0; i < Math.min(META_BACKFILL_CONCURRENCY, queue.length); i++) void worker();
    return () => {
      cancelled = true;
    };
  }, [repos, projectPath]);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const found = await invoke<GithubRepo[]>("search_github", { query: query.trim() });
      setResults(found);
    } catch (e) {
      setError(String(e));
      setResults([]);
    }
    setLoading(false);
  };

  const openInBrowser = async (url: string) => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  const cloneRepo = async (repo: GithubRepo) => {
    if (!currentProject || cloning.has(repo.full_name)) return;
    setCloning((s) => new Set(s).add(repo.full_name));
    try {
      const repoName = repo.full_name.replace("/", "-");
      await invoke("clone_github_repo", {
        projectPath: currentProject.path,
        cloneUrl: repo.clone_url,
        repoName,
        meta: metaFromSearch(repo),
      });
      setCloned((s) => new Set(s).add(repo.full_name));
      window.dispatchEvent(new Event("atlas:repo-cloned"));
      logEvent({
        source: "github",
        kind: "clone",
        summary: repo.full_name,
        payload: { repo: repo.full_name, clone_url: repo.clone_url },
      });
    } catch (e) {
      console.error("Clone failed:", e);
    }
    setCloning((s) => {
      const n = new Set(s);
      n.delete(repo.full_name);
      return n;
    });
  };

  const searching = query.trim().length > 0;
  const alreadyCloned = new Set(repos.map((r) => r.display_name));

  const scrollRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(scrollRef, [repos.length, results.length, searching, loading]);

  return (
    <div className="h-full flex flex-col">
      {/* Search */}
      <div className="flex items-center gap-1.5 h-[32px] shrink-0 border-b border-border-default bg-bg-primary px-3">
        <Search size={11} className="text-text-tertiary shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSearch();
          }}
          placeholder="Search GitHub repositories..."
          className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary"
        />
      </div>

      <div className="relative flex-1 min-h-0">
        <ScrollFade at="top" visible={edges.top} />
        <ScrollFade at="bottom" visible={edges.bottom} />
        <div ref={scrollRef} className="h-full overflow-y-auto hide-scrollbar">
          {/* Cloned repos — the resting state, hidden while a search is typed. */}
          {!searching &&
            projectPath &&
            repos.map((repo) => (
              <ClonedRow
                key={repo.name}
                repo={repo}
                projectPath={projectPath}
                onChanged={() => void refreshRepos()}
              />
            ))}

          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={16} className="animate-spin text-accent" />
            </div>
          )}

          {error && (
            <div className="px-3 py-6 text-center">
              <p className="text-[11px] text-error">{error}</p>
              <button
                onClick={handleSearch}
                className="mt-1 text-[10px] text-accent hover:underline cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && results.length === 0 && !searching && repos.length === 0 && (
            <div className="px-3 py-8 text-center">
              <GithubIcon size={16} className="text-text-tertiary mx-auto mb-2" />
              <p className="text-[11px] text-text-tertiary">Search for repositories</p>
            </div>
          )}

          {!loading && !error && results.length === 0 && searching && (
            <div className="px-3 py-6 text-center text-[11px] text-text-tertiary">
              No repositories found
            </div>
          )}

          {results.map((repo) => {
            const isCloning = cloning.has(repo.full_name);
            const isCloned = cloned.has(repo.full_name) || alreadyCloned.has(repo.full_name);
            return (
              <div
                key={repo.full_name}
                className="px-3 py-2.5 border-b border-border-default hover:bg-bg-hover group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-accent truncate">
                        {repo.full_name}
                      </span>
                    </div>
                    {repo.description && (
                      <p className="text-[10px] text-text-tertiary mt-0.5 line-clamp-2">
                        {repo.description}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-1">
                      {repo.language && (
                        <span className="text-[9px] text-text-tertiary">{repo.language}</span>
                      )}
                      <span className="flex items-center gap-0.5 text-[9px] text-text-tertiary">
                        <Star size={8} /> {repo.stars.toLocaleString()}
                      </span>
                      <span className="flex items-center gap-0.5 text-[9px] text-text-tertiary">
                        <GitFork size={8} /> {repo.forks.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => openInBrowser(repo.html_url)}
                      className="p-1 rounded hover:bg-bg-active text-text-tertiary hover:text-text-primary cursor-pointer"
                      title="Open on GitHub"
                    >
                      <ExternalLink size={11} />
                    </button>
                    {currentProject && (
                      <button
                        onClick={() => cloneRepo(repo)}
                        disabled={isCloning || isCloned}
                        className={cn(
                          "p-1 rounded cursor-pointer",
                          isCloned
                            ? "text-success"
                            : isCloning
                              ? "text-accent"
                              : "text-text-tertiary hover:text-text-primary hover:bg-bg-active",
                        )}
                        title={
                          isCloned ? "Cloned" : isCloning ? "Cloning..." : "Clone to .atlas/repos/"
                        }
                      >
                        {isCloning ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Download size={11} />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Wire shapes for the GitHub commands (Rust `commands/github.rs`, snake_case,
// no serde rename). Shared by the GitHub panel and the composer's "Add from
// GitHub" submenu so the two can't drift.

/** A `search_github` result row. */
export interface GithubRepo {
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  clone_url: string;
  language: string;
  stars: number;
  forks: number;
  updated_at: string;
}

/** What was known about a repo when it was cloned — cached by Rust in
 *  `<project>/.atlas/repo-meta.json`, never inside the clone. */
export interface RepoMeta {
  description: string;
  language: string;
  stars: number;
  forks: number;
  html_url: string;
  updated_at: string;
}

/** A repo already cloned under `<project>/.atlas/repos` (`list_cloned_repos`).
 *  `name` is the on-disk dir (`owner-repo`) — the value passed as `repoName`
 *  when cloning. */
export interface ClonedRepo {
  name: string;
  display_name: string;
  path: string;
  has_readme: boolean;
  /** The checked-out branch, or `null` when HEAD is detached. */
  branch: string | null;
  /** `null` for a clone made before Atlas cached any; `fetch_cloned_repo_meta` fills it. */
  meta: RepoMeta | null;
}

/** The `meta` to hand `clone_github_repo`, from a search result. */
export function metaFromSearch(repo: GithubRepo): RepoMeta {
  return {
    description: repo.description,
    language: repo.language,
    stars: repo.stars,
    forks: repo.forks,
    html_url: repo.html_url,
    updated_at: repo.updated_at,
  };
}

// A pull request's page on the host, opened in the system browser.
//
// A session's pull requests ride on its history row (`ThreadRow.pullRequests`,
// kept by `session_pull_requests_*`); everything else about a pull request
// goes through `pull-requests/lib/pull-requests-api.ts`.

import { openUrl } from "@tauri-apps/plugin-opener";

/** Open a PR's page in the system browser. */
export function openPullRequest(url: string): void {
  void openUrl(url).catch(() => window.open(url, "_blank"));
}

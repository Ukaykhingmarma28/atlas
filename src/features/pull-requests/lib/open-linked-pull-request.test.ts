import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, openTab, openExternal } = vi.hoisted(() => ({
  invoke: vi.fn(),
  openTab: vi.fn(),
  openExternal: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./open-pull-request-tab", () => ({ openPullRequestTab: openTab }));
vi.mock("@/features/git/lib/git-pr-api", () => ({ openPullRequest: openExternal }));

import { resetGhGateForTests } from "./pr-errors";
import { linkBelongsToCheckout, openLinkedPullRequest } from "./open-linked-pull-request";

const provider = { host: "github.com", repository: "acme/shop" };
const link = (repository: string, host = "github.com") => ({
  repository,
  number: 12,
  url: `https://${host}/${repository}/pull/12`,
});

afterEach(() => {
  invoke.mockReset();
  openTab.mockReset();
  openExternal.mockReset();
  resetGhGateForTests();
});

describe("openLinkedPullRequest", () => {
  it("knows a link of the checkout's own repository and host", () => {
    expect(linkBelongsToCheckout(link("Acme/Shop"), provider)).toBe(true);
    expect(linkBelongsToCheckout(link("other/repo"), provider)).toBe(false);
    expect(linkBelongsToCheckout(link("acme/shop", "ghe.example.com"), provider)).toBe(false);
  });

  it("opens a tab for the checkout's own pull request", async () => {
    invoke.mockResolvedValue(provider);
    await openLinkedPullRequest("/repo", link("acme/shop"));
    expect(openTab).toHaveBeenCalledWith({ repoPath: "/repo", number: 12, title: "#12" });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens another repository's pull request on the host, not as cwd + number", async () => {
    invoke.mockResolvedValue(provider);
    await openLinkedPullRequest("/repo", link("other/repo"));
    expect(openTab).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://github.com/other/repo/pull/12");
  });

  it("opens on the host when the checkout cannot be read", async () => {
    invoke.mockRejectedValue({ kind: "failed", message: "no remote" });
    await openLinkedPullRequest("/repo", link("acme/shop"));
    expect(openTab).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalled();
  });
});

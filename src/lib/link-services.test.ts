// Which service a web link belongs to, and the short label a bare one reads as.

import { describe, expect, it } from "vitest";
import {
  leadingLinkTextLength,
  linkFacts,
  linkServiceOfHost,
  parseChangeRequestUrl,
  textIsAddress,
} from "./link-services";

describe("linkServiceOfHost", () => {
  it.each([
    ["github.com", "github"],
    ["gist.github.com", "github"],
    ["github.acme.com", "github"],
    ["raw.githubusercontent.com", "github"],
    ["gitlab.com", "gitlab"],
    ["gitlab.internal.dev", "gitlab"],
    ["bitbucket.org", "bitbucket"],
    ["codeberg.org", "forgejo"],
    ["linear.app", "linear"],
    ["acme.slack.com", "slack"],
    ["www.notion.so", "notion"],
    ["acme.notion.site", "notion"],
    ["www.figma.com", "figma"],
    ["vercel.com", "vercel"],
    ["web-acme.vercel.app", "vercel"],
    ["www.npmjs.com", "npm"],
    ["example.com", "web"],
    ["notgithub.com", "web"],
    ["linear.app.evil.com", "web"],
    ["localhost", "web"],
  ])("%s → %s", (host, service) => {
    expect(linkServiceOfHost(host)).toBe(service);
  });
});

describe("parseChangeRequestUrl", () => {
  it("reads each forge's pull request route", () => {
    expect(parseChangeRequestUrl("https://github.com/Acme/Web/pull/42/files")).toEqual({
      host: "github.com",
      repository: "acme/web",
      number: 42,
    });
    expect(parseChangeRequestUrl("https://gitlab.com/a/b/c/-/merge_requests/7")?.number).toBe(7);
    expect(parseChangeRequestUrl("https://bitbucket.org/a/b/pull-requests/3")?.number).toBe(3);
    expect(parseChangeRequestUrl("https://codeberg.org/a/b/pulls/5")?.number).toBe(5);
    expect(
      parseChangeRequestUrl("https://dev.azure.com/org/proj/_git/repo/pullrequest/9")?.number,
    ).toBe(9);
  });

  it("rejects what is not a pull request", () => {
    expect(parseChangeRequestUrl("https://github.com/a/b/pull/0")).toBeNull();
    expect(parseChangeRequestUrl("https://github.com/a/b/pulls")).toBeNull();
    expect(parseChangeRequestUrl("https://github.com/a/b/issues/4")).toBeNull();
    expect(parseChangeRequestUrl("https://example.com/a/b/pull/4")).toBeNull();
    expect(parseChangeRequestUrl("mailto:x@y.z")).toBeNull();
    expect(parseChangeRequestUrl("not a url")).toBeNull();
  });
});

describe("linkFacts", () => {
  it.each([
    ["https://github.com/acme/web/pull/42", "github", "PR #42", false],
    ["https://github.com/acme/web/pull/42/files#diff-1", "github", "PR #42", false],
    ["https://github.com/acme/web/issues/17", "github", "#17", false],
    [
      "https://github.com/acme/web/commit/3f9c2d1e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d",
      "github",
      "3f9c2d1",
      true,
    ],
    ["https://github.com/acme/web", "github", "acme/web", false],
    ["https://github.com/acme/web/", "github", "acme/web", false],
    ["https://github.com/acme/web.git", "github", "acme/web", false],
    ["https://github.com/acme/web/tree/main/src", "github", null, false],
    ["https://github.com/settings/tokens", "github", null, false],
    ["https://github.com/acme", "github", null, false],
    ["https://github.com/acme/web?tab=readme", "github", null, false],
    ["https://gist.github.com/acme/abc123", "github", null, false],
    [
      "https://linear.app/atlas/issue/ATL-978/browser-goes-agent-driven",
      "linear",
      "ATL-978",
      false,
    ],
    ["https://linear.app/atlas/issue/atl-981", "linear", "ATL-981", false],
    ["https://linear.app/atlas/project/browser-2f1c", "linear", null, false],
    ["https://gitlab.com/acme/api/-/merge_requests/7", "gitlab", "PR #7", false],
    ["https://gitlab.com/acme/api/-/issues/8", "gitlab", "#8", false],
    ["https://bitbucket.org/acme/infra/pull-requests/3", "bitbucket", "PR #3", false],
    ["https://codeberg.org/acme/tools/pulls/5", "forgejo", "PR #5", false],
    ["https://acme.slack.com/archives/C024BE91L/p1700000000000100", "slack", null, false],
    ["https://www.npmjs.com/package/react-markdown", "npm", null, false],
    ["https://example.com/docs", "web", null, false],
    ["http://localhost:5173/", "web", null, false],
  ])("%s", (href, service, short, commit) => {
    expect(linkFacts(href)).toEqual({ service, short, commit });
  });

  it("is null for anything that is not a web address", () => {
    for (const href of [
      "README.md",
      "#section",
      "mailto:a@b.c",
      "file:///etc/hosts",
      "javascript:x",
    ])
      expect(linkFacts(href)).toBeNull();
  });
});

describe("textIsAddress", () => {
  it("matches a bare link, GFM's www form and a trailing slash", () => {
    expect(textIsAddress("https://github.com/a/b", "https://github.com/a/b")).toBe(true);
    expect(textIsAddress("www.github.com/a/b", "http://www.github.com/a/b")).toBe(true);
    expect(textIsAddress("https://github.com/a/b/", "https://github.com/a/b")).toBe(true);
  });

  it("does not match words of the link's own", () => {
    expect(textIsAddress("the review", "https://github.com/a/b/pull/1")).toBe(false);
    expect(textIsAddress("PR 1", "https://github.com/a/b/pull/1")).toBe(false);
    expect(textIsAddress("", "https://github.com/a/b/pull/1")).toBe(false);
  });
});

describe("leadingLinkTextLength", () => {
  it("keeps the protocol, or one character, beside the icon", () => {
    expect(leadingLinkTextLength("https://example.com")).toBe(8);
    expect(leadingLinkTextLength("PR #42")).toBe(1);
    expect(leadingLinkTextLength("")).toBe(0);
  });
});

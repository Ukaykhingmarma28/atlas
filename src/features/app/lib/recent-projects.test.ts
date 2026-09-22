import { describe, expect, it } from "vitest";
import { recentsForOrg } from "./recent-projects";

const ACME = "org-acme";
const OTHER = "org-other";

const recent = (path: string, orgId?: string | null) => ({ path, orgId });
const project = (path: string, orgId: string) => ({ path, orgId });

describe("recentsForOrg", () => {
  it("keeps only the active org's entries", () => {
    const out = recentsForOrg(
      [recent("/a", ACME), recent("/b", OTHER), recent("/c", ACME)],
      [],
      ACME,
    );
    expect(out.map((r) => r.path)).toEqual(["/a", "/c"]);
  });

  /** The bug this exists for: another tenant's paths were listed verbatim. */
  it("never leaks a path that belongs to a different org", () => {
    const out = recentsForOrg([recent("/secret-client", OTHER)], [], ACME);
    expect(out).toEqual([]);
  });

  it("attributes a legacy untagged entry by path against the project list", () => {
    const out = recentsForOrg(
      [recent("/a", null), recent("/b", null)],
      [project("/a", ACME), project("/b", OTHER)],
      ACME,
    );
    expect(out.map((r) => r.path)).toEqual(["/a"]);
  });

  it("shows a legacy entry that matches a project in the active org among several", () => {
    // The same folder can legitimately be open in more than one org.
    const out = recentsForOrg(
      [recent("/shared", null)],
      [project("/shared", OTHER), project("/shared", ACME)],
      ACME,
    );
    expect(out.map((r) => r.path)).toEqual(["/shared"]);
  });

  it("shows an untagged entry that belongs to no project at all", () => {
    // Attributable to nobody, so it discloses nothing — and hiding a path the
    // user opened themselves would be the worse failure.
    const out = recentsForOrg([recent("/orphan", null)], [project("/a", OTHER)], ACME);
    expect(out.map((r) => r.path)).toEqual(["/orphan"]);
  });

  it("returns nothing before the org layer has hydrated", () => {
    expect(recentsForOrg([recent("/a", ACME)], [], null)).toEqual([]);
    expect(recentsForOrg([recent("/a", ACME)], [], undefined)).toEqual([]);
  });

  it("ignores projects that carry no org when attributing", () => {
    const out = recentsForOrg([recent("/a", null)], [{ path: "/a", orgId: null }], ACME);
    // Untagged project gives no evidence either way, so the entry is unowned.
    expect(out.map((r) => r.path)).toEqual(["/a"]);
  });
});

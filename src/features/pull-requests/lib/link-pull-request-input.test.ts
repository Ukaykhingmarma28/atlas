import { describe, expect, it } from "vitest";

import { resolveLinkInput } from "./link-pull-request-input";

describe("resolveLinkInput", () => {
  it("reads a number with or without the hash", () => {
    expect(resolveLinkInput("42", null)).toEqual({ kind: "ok", number: 42 });
    expect(resolveLinkInput("  #7 ", "acme/shop")).toEqual({ kind: "ok", number: 7 });
    expect(resolveLinkInput("#0", null).kind).toBe("error");
  });

  it("is empty for blank input", () => {
    expect(resolveLinkInput("   ", null)).toEqual({ kind: "empty" });
  });

  it("reads a URL of the session's own repository, whatever its tail", () => {
    expect(resolveLinkInput("https://github.com/acme/shop/pull/12", "acme/shop")).toEqual({
      kind: "ok",
      number: 12,
    });
    expect(
      resolveLinkInput("https://github.com/Acme/Shop/pull/12/files?diff=split", "acme/shop"),
    ).toEqual({ kind: "ok", number: 12 });
  });

  it("refuses a URL of another repository, and anything else", () => {
    const other = resolveLinkInput("https://github.com/other/repo/pull/3", "acme/shop");
    expect(other.kind).toBe("error");
    expect(resolveLinkInput("https://github.com/acme/shop/issues/3", "acme/shop").kind).toBe(
      "error",
    );
    expect(resolveLinkInput("discounts", "acme/shop").kind).toBe("error");
  });
});

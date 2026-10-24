import { describe, expect, it } from "vitest";

import { resolveLinkInput } from "./link-pull-request-input";

const shop = { host: "github.com", repository: "acme/shop" };

describe("resolveLinkInput", () => {
  it("reads a number with or without the hash", () => {
    expect(resolveLinkInput("42", null)).toEqual({ kind: "ok", number: 42 });
    expect(resolveLinkInput("  #7 ", shop)).toEqual({ kind: "ok", number: 7 });
    expect(resolveLinkInput("#0", null).kind).toBe("error");
  });

  it("is empty for blank input", () => {
    expect(resolveLinkInput("   ", null)).toEqual({ kind: "empty" });
  });

  it("reads a URL of the session's own repository, whatever its tail", () => {
    expect(resolveLinkInput("https://github.com/acme/shop/pull/12", shop)).toEqual({
      kind: "ok",
      number: 12,
    });
    expect(resolveLinkInput("https://github.com/Acme/Shop/pull/12/files?diff=split", shop)).toEqual(
      { kind: "ok", number: 12 },
    );
    expect(resolveLinkInput("https://www.GitHub.com/acme/shop/pull/12", shop).kind).toBe("ok");
  });

  it("takes no URL until the session's repository is known", () => {
    // While unknown, a URL from anywhere would resolve to a number in this
    // checkout and link the wrong pull request.
    expect(resolveLinkInput("https://github.com/other/repo/pull/3", null).kind).toBe("waiting");
    expect(resolveLinkInput("https://github.com/acme/shop/pull/3", null).kind).toBe("waiting");
  });

  it("refuses a URL of another repository or another host, and anything else", () => {
    expect(resolveLinkInput("https://github.com/other/repo/pull/3", shop).kind).toBe("error");
    expect(resolveLinkInput("https://github.com/acme/other/pull/3", shop).kind).toBe("error");
    const elsewhere = resolveLinkInput("https://ghe.example.com/acme/shop/pull/3", shop);
    expect(elsewhere).toMatchObject({ kind: "error" });
    expect(elsewhere.kind === "error" && elsewhere.message).toMatch(/ghe\.example\.com/);
    expect(resolveLinkInput("https://github.com/acme/shop/issues/3", shop).kind).toBe("error");
    expect(resolveLinkInput("discounts", shop).kind).toBe("error");
  });
});

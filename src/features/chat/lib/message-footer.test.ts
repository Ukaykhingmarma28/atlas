import { describe, expect, it } from "vitest";
import { latestResponseRowId, responseFooterActions, userFooterActions } from "./message-footer";
import { RowKind, type Row } from "./turn-rows";

describe("userFooterActions", () => {
  it("keeps copy inline and tucks edit and pin into the menu", () => {
    expect(userFooterActions({ canRetry: false, pinned: false })).toEqual({
      inline: ["copy"],
      overflow: ["edit", "pin"],
    });
  });

  it("leads with retry on the retryable prompt", () => {
    expect(userFooterActions({ canRetry: true, pinned: false })).toEqual({
      inline: ["retry", "copy"],
      overflow: ["edit", "pin"],
    });
  });

  it("brings a pinned prompt's pin out of the menu, lit", () => {
    expect(userFooterActions({ canRetry: true, pinned: true })).toEqual({
      inline: ["retry", "pin", "copy"],
      overflow: ["edit"],
    });
  });

  it("never offers branch on a prompt", () => {
    for (const canRetry of [false, true]) {
      for (const pinned of [false, true]) {
        const { inline, overflow } = userFooterActions({ canRetry, pinned });
        expect([...inline, ...overflow]).not.toContain("branch");
      }
    }
  });
});

describe("responseFooterActions", () => {
  it("keeps copy inline and pin in the menu", () => {
    expect(responseFooterActions({ canBranch: false, pinned: false })).toEqual({
      inline: ["copy"],
      overflow: ["pin"],
    });
  });

  it("adds branch after copy on the latest response", () => {
    expect(responseFooterActions({ canBranch: true, pinned: false })).toEqual({
      inline: ["copy", "branch"],
      overflow: ["pin"],
    });
  });

  it("drops the menu entirely once the response is pinned", () => {
    expect(responseFooterActions({ canBranch: true, pinned: true })).toEqual({
      inline: ["copy", "branch", "pin"],
      overflow: [],
    });
  });

  it("never offers retry or edit on a response", () => {
    for (const canBranch of [false, true]) {
      for (const pinned of [false, true]) {
        const { inline, overflow } = responseFooterActions({ canBranch, pinned });
        expect([...inline, ...overflow]).not.toContain("retry");
        expect([...inline, ...overflow]).not.toContain("edit");
      }
    }
  });
});

describe("latestResponseRowId", () => {
  const base = { turnId: "t", firstInTurn: false };
  const user = (id: string): Row => ({
    ...base,
    id,
    kind: RowKind.User,
    text: "q",
    contextBlocks: 0,
    expanded: false,
    attachments: [],
    timestamp: "2026-10-24T09:00:00Z",
  });
  const prose = (id: string, streaming = false): Row => ({
    ...base,
    id,
    kind: RowKind.Prose,
    text: "a",
    streaming,
    showHeader: false,
    model: null,
    timestamp: "2026-10-24T09:00:00Z",
  });
  const separator = (id: string) => ({ ...base, id, kind: RowKind.Separator }) as unknown as Row;

  it("picks the last prose row of the last exchange", () => {
    expect(latestResponseRowId([user("u:1"), prose("p:1"), prose("p:2")])).toBe("p:2");
  });

  it("looks past trailing non-prose rows", () => {
    expect(latestResponseRowId([user("u:1"), prose("p:1"), separator("s:1")])).toBe("p:1");
  });

  it("offers nothing while the response is still streaming", () => {
    expect(latestResponseRowId([user("u:1"), prose("p:1", true)])).toBeUndefined();
  });

  it("offers nothing when the last prompt has no answer yet", () => {
    expect(latestResponseRowId([user("u:1"), prose("p:1"), user("u:2")])).toBeUndefined();
  });

  it("offers nothing on an empty session", () => {
    expect(latestResponseRowId([])).toBeUndefined();
  });
});

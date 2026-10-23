// A large paste reaches every agent in full. Rust picks the form by the
// agent's `promptCapabilities.embeddedContext` (its tests in
// `atlas-acp-thread/src/prompt.rs` cover both branches); this suite holds the
// frontend half: the chip keeps the whole text, the send carries it beside the
// prose rather than through `compose_prompt`, and the paths that only carry
// plain text — the queue, and the mock agent that lacks the capability — get
// the same fenced form Rust sends such an agent.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { agentHandlers, receivedText, setPromptHandler } from "@/dev/mock-backend/fake-agent";
import { composePrompt, toShortForm, type MentionData } from "./mentions";
import { pasteAsText, pastedTextMention, withPastesInline } from "./pasted-text";

const big = Array.from({ length: 120 }, (_, i) => `log line ${i}`).join("\n");

beforeEach(() => {
  invoke.mockReset();
  setPromptHandler(null);
});

describe("the paste chip", () => {
  it("holds the whole text and writes a short token", () => {
    const m = pastedTextMention(big);
    expect(m.text).toBe(big);
    expect(m.lines).toBe(120);
    expect(toShortForm(m)).toBe(`@paste:${m.id}`);
  });
});

describe("the send", () => {
  it("carries each paste beside the prose, and keeps it away from compose_prompt", async () => {
    const paste = pastedTextMention(big);
    const file: MentionData = {
      kind: "file",
      id: "/p/a.ts",
      displayName: "a.ts",
      absPath: "/p/a.ts",
    };
    invoke.mockResolvedValue({
      prose: "look",
      resourceLinks: [{ uri: "file:///p/a.ts", name: "a.ts" }],
    });
    const composed = await composePrompt("look", [paste, file]);
    expect(invoke).toHaveBeenCalledWith("compose_prompt", { prose: "look", mentions: [file] });
    expect(composed.pastedTexts).toEqual([{ id: paste.id, text: big }]);
  });

  it("does not call compose_prompt for a turn whose only mention is a paste", async () => {
    const paste = pastedTextMention(big);
    const composed = await composePrompt("look", [paste]);
    expect(invoke).not.toHaveBeenCalled();
    expect(composed).toEqual({
      prose: "look",
      resourceLinks: [],
      pastedTexts: [{ id: paste.id, text: big }],
    });
  });
});

describe("the text form (an agent without embeddedContext)", () => {
  it("matches what Rust sends: a header, then the text in a fence", () => {
    // Same expectation as `a_paste_is_fenced_text_for_an_agent_without_embedded_context`.
    expect(pasteAsText({ id: "p1", text: "a\nb" })).toBe(
      "Pasted text (@paste:p1, 2 lines):\n```\na\nb\n```",
    );
  });

  it("uses a fence the text cannot close", () => {
    expect(pasteAsText({ id: "p1", text: "```rust\nfn main() {}\n```" })).toBe(
      "Pasted text (@paste:p1, 3 lines):\n````\n```rust\nfn main() {}\n```\n````",
    );
  });

  it("goes into a queued message whole", () => {
    const paste = pastedTextMention(big);
    const queued = withPastesInline(`see @paste:${paste.id}`, [paste]);
    expect(queued.startsWith(`see @paste:${paste.id}\n\n`)).toBe(true);
    expect(queued).toContain(big);
  });
});

describe("the mock agent, which lacks embeddedContext", () => {
  it("receives the full paste as a text block after the prose", async () => {
    const received: string[] = [];
    setPromptHandler(({ text }) => {
      received.push(text);
      return true;
    });
    const { key } = agentHandlers.agents_new_session({ agentId: "agent-mock", cwd: "/p" }) as {
      key: { agent_id: string; session_id: string };
    };
    await agentHandlers.agents_send({
      key,
      text: "summarise @paste:p9",
      pastedTexts: [{ id: "p9", text: big }],
    });
    expect(received).toEqual([`summarise @paste:p9\n\n${pasteAsText({ id: "p9", text: big })}`]);
    expect(received[0]).toContain(big);
    expect(receivedText("x", [])).toBe("x");
  });
});

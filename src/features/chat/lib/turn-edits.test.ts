import { describe, expect, it } from "vitest";
import {
  collectTurnEdits,
  editsSignature,
  listEditTurns,
  PROMPT_SNIPPET_CHARS,
} from "./turn-edits";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";

const REPO = "/repo";

function toolCall(tc: Partial<ToolCallDisplay>): ToolCallDisplay {
  return {
    id: "tc",
    toolName: "apply_patch",
    status: "completed",
    arguments: {},
    result: null,
    locations: [],
    contentBlocks: [],
    ...tc,
  } as ToolCallDisplay;
}

/** One assistant turn, `t:m1`, made of the given tool calls. */
function turn(...toolCalls: ToolCallDisplay[]): ChatMessage[] {
  return [
    {
      id: "m1",
      role: "assistant",
      content: "",
      toolCalls,
      fileChanges: [],
      plan: null,
      timestamp: "2026-08-23T00:00:00Z",
      mode: "tool",
    } as ChatMessage,
  ];
}

function diffBlock(path: string, oldText: string | undefined, newText: string) {
  return oldText === undefined
    ? { type: "diff" as const, path, newText }
    : { type: "diff" as const, path, oldText, newText };
}

describe("edits reported as ACP diff blocks", () => {
  it("carries the block's before and after text", () => {
    const edits = collectTurnEdits(
      turn(toolCall({ contentBlocks: [diffBlock("/repo/a.ts", "before\n", "after\n")] })),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["a.ts"]);
    expect(edits.sources["a.ts"]).toEqual({ old: "before\n", new: "after\n" });
  });

  it("folds repeat edits to one file as first-before against last-after", () => {
    // The bug this pins: `acp::Diff` carries the WHOLE file either side, not
    // the replaced fragment. Concatenating two of them gave `old = v0 + v1`
    // against `new = v1 + v2` — a diff of the file against a doubled copy of
    // itself, which rendered as every line changed.
    const edits = collectTurnEdits(
      turn(
        toolCall({ id: "tc1", contentBlocks: [diffBlock("/repo/a.ts", "v0\n", "v1\n")] }),
        toolCall({ id: "tc2", contentBlocks: [diffBlock("/repo/a.ts", "v1\n", "v2\n")] }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["a.ts"]);
    expect(edits.sources["a.ts"]).toEqual({ old: "v0\n", new: "v2\n" });
  });

  it("treats an absent before-text as a created file", () => {
    const edits = collectTurnEdits(
      turn(toolCall({ contentBlocks: [diffBlock("/repo/new.ts", undefined, "hello\n")] })),
      "t:m1",
      REPO,
    );
    expect(edits.sources["new.ts"]).toEqual({ old: "", new: "hello\n" });
  });

  it("keeps several files apart, in the order the turn touched them", () => {
    const edits = collectTurnEdits(
      turn(
        toolCall({
          contentBlocks: [
            diffBlock("/repo/b.ts", "b0\n", "b1\n"),
            diffBlock("/repo/a.ts", "a0\n", "a1\n"),
          ],
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["b.ts", "a.ts"]);
    expect(edits.sources["a.ts"].new).toBe("a1\n");
    expect(edits.sources["b.ts"].new).toBe("b1\n");
  });
});

describe("edits reported as tool arguments", () => {
  it("still concatenates fragments, which is what Edit arguments carry", () => {
    // Unlike a diff block, an `Edit` names only the text it replaced, so two
    // edits to one file legitimately add up to one fragment pair.
    const edits = collectTurnEdits(
      turn(
        toolCall({
          id: "tc1",
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "one\n", new_string: "ONE\n" },
        }),
        toolCall({
          id: "tc2",
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "two\n", new_string: "TWO\n" },
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.sources["a.ts"]).toEqual({ old: "one\ntwo\n", new: "ONE\nTWO\n" });
  });

  it("prefers the whole file when the same path came both ways", () => {
    // A fragment pair cannot improve on the complete file.
    const edits = collectTurnEdits(
      turn(
        toolCall({
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "one\n", new_string: "ONE\n" },
          contentBlocks: [diffBlock("/repo/a.ts", "one\ntwo\n", "ONE\ntwo\n")],
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.sources["a.ts"]).toEqual({ old: "one\ntwo\n", new: "ONE\ntwo\n" });
  });
});

describe("which file the viewer lands on", () => {
  const messages = turn(
    toolCall({
      contentBlocks: [
        diffBlock("/repo/b.ts", "b0\n", "b1\n"),
        diffBlock("/repo/a.ts", "a0\n", "a1\n"),
      ],
    }),
  );

  it("is the requested one when the turn touched it", () => {
    expect(collectTurnEdits(messages, "t:m1", REPO, "/repo/a.ts").initial).toBe("a.ts");
  });

  it("falls back to the first file when the requested one is not in the turn", () => {
    expect(collectTurnEdits(messages, "t:m1", REPO, "/repo/z.ts").initial).toBe("b.ts");
  });

  it("is empty for a turn that changed nothing", () => {
    const none = collectTurnEdits(turn(toolCall({ toolName: "Read" })), "t:m1", REPO);
    expect(none).toEqual({ files: [], initial: "", sources: {}, excerpts: new Set() });
  });
});

describe("which files are only excerpts", () => {
  it("marks a file the turn knew only by the fragments it replaced", () => {
    const edits = collectTurnEdits(
      turn(
        toolCall({
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "one\n", new_string: "ONE\n" },
        }),
      ),
      "t:m1",
      REPO,
    );
    expect([...edits.excerpts]).toEqual(["a.ts"]);
  });

  it("does not mark a whole file written out, or one a diff block carried", () => {
    const edits = collectTurnEdits(
      turn(
        toolCall({
          id: "w",
          toolName: "Write",
          arguments: { file_path: "/repo/new.ts", content: "x\n" },
        }),
        toolCall({
          id: "e",
          toolName: "Edit",
          arguments: { file_path: "/repo/b.ts", old_string: "b\n", new_string: "B\n" },
          contentBlocks: [diffBlock("/repo/b.ts", "a\nb\n", "a\nB\n")],
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["new.ts", "b.ts"]);
    expect(edits.excerpts.size).toBe(0);
  });
});

function message(id: string, role: "user" | "assistant", extra: Partial<ChatMessage> = {}) {
  return {
    id,
    role,
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: `2026-08-23T00:00:${id.replace(/\D/g, "").padStart(2, "0")}Z`,
    mode: "text",
    ...extra,
  } as ChatMessage;
}

const edit = (path: string, id = path) =>
  toolCall({
    id,
    toolName: "Edit",
    arguments: { file_path: `/repo/${path}`, old_string: "a", new_string: "b" },
  });

describe("listEditTurns", () => {
  const messages = [
    message("u1", "user", { content: "Fix the login form" }),
    message("a2", "assistant", { toolCalls: [edit("src/login.tsx"), edit("src/login.tsx", "x")] }),
    message("a3", "assistant", { toolCalls: [edit("src/auth.ts")] }),
    message("u4", "user", { content: "Where is the cookie set?" }),
    message("a5", "assistant", { toolCalls: [toolCall({ toolName: "Read" })] }),
    message("u6", "user", {
      content: "Long prompt\n\nwith context",
      atlasProse: `Add a users route ${"and more words ".repeat(10)}`,
    }),
    message("a7", "assistant", {
      toolCalls: [toolCall({ contentBlocks: [diffBlock("/repo/routes.ts", "a", "b")] })],
    }),
  ];

  it("lists the turns that changed files, newest first, numbered among all turns", () => {
    const turns = listEditTurns(messages, REPO);
    expect(turns.map((t) => [t.turnId, t.number, t.fileCount])).toEqual([
      ["t:a7", 3, 1],
      ["t:a2", 1, 2],
    ]);
  });

  it("stamps each with when it finished and the prompt it answered, on one line", () => {
    const [latest, first] = listEditTurns(messages, REPO);
    expect(first.timestamp).toBe(messages[2].timestamp);
    expect(first.prompt).toBe("Fix the login form");
    // The prose without its @-mention context, cut to the snippet length.
    expect(latest.prompt.startsWith("Add a users route and more words")).toBe(true);
    expect(latest.prompt.length).toBe(PROMPT_SNIPPET_CHARS);
    expect(latest.prompt.endsWith("…")).toBe(true);
  });

  it("uses the same turn ids collectTurnEdits reads", () => {
    for (const t of listEditTurns(messages, REPO)) {
      expect(collectTurnEdits(messages, t.turnId, REPO).files.length).toBe(t.fileCount);
    }
  });
});

describe("editsSignature", () => {
  it("ignores streamed prose and changes when a call arrives or settles", () => {
    const base = [message("u1", "user"), message("a2", "assistant", { content: "Hel" })];
    const sig = editsSignature(base);
    const streamed = [base[0], { ...base[1], content: "Hello there" }];
    expect(editsSignature(streamed)).toBe(sig);
    const called = [base[0], { ...base[1], toolCalls: [edit("a.ts")] }];
    expect(editsSignature(called)).not.toBe(sig);
    const settled = [
      base[0],
      { ...base[1], toolCalls: [{ ...edit("a.ts"), status: "failed" as const }] },
    ];
    expect(editsSignature(settled)).not.toBe(editsSignature(called));
    expect(editsSignature([...base, message("u3", "user")])).not.toBe(sig);
  });
});

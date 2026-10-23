// The native engine's `{ paths, patch }` edit, read per file. The fixtures are
// the shapes `format_file_change_diff` produces: an update's headerless hunks
// (with a `Moved to:` note for a rename), a created or deleted file's whole
// content, all joined with a newline in `paths` order.

import { describe, expect, it } from "vitest";
import { applyHunks, enginePatchFiles, hunksExcerpt } from "./engine-patch";
import { countEditLines, isFileCreated, turnFilesOfToolCall } from "./tool-files";

const update = "@@ -1,3 +1,4 @@\n use a;\n+use b;\n \n fn f() {}\n";
const twoHunks = "@@ -1,2 +1,2 @@\n-x\n+X\n y\n@@ -10,1 +10,2 @@\n z\n+Z\n";
const created = "line one\nline two\n";

const join = (...texts: string[]) => texts.join("\n");

describe("enginePatchFiles", () => {
  it("is null for arguments that are not the engine's shape", () => {
    expect(enginePatchFiles({ file_path: "/a", old_string: "x" })).toBeNull();
    expect(enginePatchFiles({ paths: [], patch: "" })).toBeNull();
  });

  it("reads one update by its hunk counts", () => {
    expect(enginePatchFiles({ paths: ["/r/a.rs"], patch: update })).toEqual([
      { path: "/r/a.rs", shape: "hunks", text: update, added: 1, removed: 0 },
    ]);
  });

  it("gives an empty context line back its space, so any parser reads it", () => {
    const [file] = enginePatchFiles({
      paths: ["/r/a.rs"],
      patch: "@@ -1,3 +1,4 @@\n a\n+b\n\n c\n",
    })!;
    expect(file.text).toBe("@@ -1,3 +1,4 @@\n a\n+b\n \n c\n");
  });

  it("reads a created file as its whole content", () => {
    expect(enginePatchFiles({ paths: ["/r/new.rs"], patch: created })).toEqual([
      { path: "/r/new.rs", shape: "content", text: created, added: 2, removed: 0 },
    ]);
  });

  it("splits updates and created files in either order", () => {
    const files = enginePatchFiles({
      paths: ["/r/a.rs", "/r/b.rs", "/r/c.rs", "/r/d.rs"],
      patch: join(update, created, twoHunks, created),
    })!;
    expect(files.map((f) => [f.path, f.shape, f.added, f.removed])).toEqual([
      ["/r/a.rs", "hunks", 1, 0],
      ["/r/b.rs", "content", 2, 0],
      ["/r/c.rs", "hunks", 2, 1],
      ["/r/d.rs", "content", 2, 0],
    ]);
    expect(files[1].text).toBe(created);
    expect(files[2].text).toBe(twoHunks);
  });

  it("steps over a rename's note to the next file", () => {
    const renamed = `${update}\n\nMoved to: /r/z.rs`;
    const files = enginePatchFiles({
      paths: ["/r/a.rs", "/r/b.rs"],
      patch: join(renamed, update),
    })!;
    expect(files.map((f) => [f.shape, f.text])).toEqual([
      ["hunks", update],
      ["hunks", update],
    ]);
  });

  it("gives up, file by file, where two whole contents meet", () => {
    const files = enginePatchFiles({
      paths: ["/r/a.rs", "/r/b.rs", "/r/c.rs"],
      patch: join(update, created, created),
    })!;
    expect(files.map((f) => f.shape)).toEqual(["hunks", "unknown", "unknown"]);
  });

  it("names every file, with no text, while the patch is empty", () => {
    const files = enginePatchFiles({ paths: ["/r/a.rs", "/r/b.rs"], patch: "" })!;
    expect(files.map((f) => [f.path, f.shape])).toEqual([
      ["/r/a.rs", "unknown"],
      ["/r/b.rs", "unknown"],
    ]);
  });
});

describe("hunksExcerpt", () => {
  it("is the context and removed lines against the context and added ones", () => {
    expect(hunksExcerpt(twoHunks)).toEqual({ old: "x\ny\nz\n", new: "X\ny\nz\nZ\n" });
  });
});

describe("applyHunks", () => {
  const text = "use a;\n\nfn f() {}\n";

  it("applies hunks where their headers say", () => {
    expect(applyHunks(text, update)).toBe("use a;\nuse b;\n\nfn f() {}\n");
  });

  it("is null when the text there is not what the hunk expects", () => {
    expect(applyHunks("something else\n", update)).toBeNull();
  });
});

describe("a native edit as the turn's record keeps it", () => {
  const call = {
    toolName: "Edit /r/a.rs (+1 more)",
    kind: "edit",
    arguments: { paths: ["/r/a.rs", "/r/new.rs"], patch: join(update, created) },
  };

  it("is one file per path, each with its own counts", () => {
    // Before: one file, the first path, at +0 −0.
    expect(turnFilesOfToolCall(call)).toEqual([
      { path: "/r/a.rs", kind: "edit", added: 1, removed: 0, created: false },
      { path: "/r/new.rs", kind: "edit", added: 2, removed: 0, created: true },
    ]);
  });

  it("counts every file on the call's own marker", () => {
    expect(countEditLines(call.toolName, call.arguments, call.kind)).toEqual({
      added: 3,
      removed: 0,
    });
    expect(isFileCreated(call.toolName, call.arguments, call.kind)).toBe(false);
  });
});

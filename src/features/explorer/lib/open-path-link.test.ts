import { beforeEach, describe, expect, it, vi } from "vitest";

const openInProject = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./open-in-project", () => ({ openInProject }));
const search = vi.hoisted(() => vi.fn());
vi.mock("@/features/file-picker/lib/file-picker-api", () => ({ fileIndex: { search } }));
const project = vi.hoisted(() => ({ path: "/p" as string | null }));
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: {
    getState: () => ({ currentProject: project.path ? { path: project.path } : null }),
  },
}));
const openPath = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { locateInProject, openPathLink } from "./open-path-link";

beforeEach(() => {
  vi.clearAllMocks();
  project.path = "/p";
  search.mockResolvedValue([]);
});

describe("opening a session's file chip", () => {
  it("opens a project file as a tab, at the line the chip named", async () => {
    search.mockResolvedValue([{ path: "/p/src/a.ts", rel: "src/a.ts" }]);
    await openPathLink({ path: "/p/src/a.ts", line: 12 });
    expect(openInProject).toHaveBeenCalledWith("/p/src/a.ts", undefined, {
      reveal: { line: 12, column: undefined },
    });
    expect(openPath).not.toHaveBeenCalled();
  });

  it("opens without a reveal when no line was named", async () => {
    await openPathLink({ path: "/p/src/a.ts" });
    expect(openInProject).toHaveBeenCalledWith("/p/src/a.ts", undefined, undefined);
  });

  it("hands a file outside the project to the system", async () => {
    await openPathLink({ path: "/elsewhere/x.ts", line: 3 });
    expect(openPath).toHaveBeenCalledWith("/elsewhere/x.ts");
    expect(openInProject).not.toHaveBeenCalled();
  });

  it("hands a folder to the system's file manager", async () => {
    await openPathLink({ path: "/p/src", folder: true });
    expect(openPath).toHaveBeenCalledWith("/p/src");
  });

  it("hands anything to the system when no project is open", async () => {
    project.path = null;
    await openPathLink({ path: "/p/src/a.ts" });
    expect(openPath).toHaveBeenCalledWith("/p/src/a.ts");
  });
});

describe("locateInProject", () => {
  it("finds the one indexed file a short path stands for", async () => {
    search.mockResolvedValue([
      { path: "/p/src/lib/api.ts", rel: "src/lib/api.ts" },
      { path: "/p/src/lib/api.test.ts", rel: "src/lib/api.test.ts" },
    ]);
    expect(await locateInProject("/p/api.ts", "/p")).toBe("/p/src/lib/api.ts");
    expect(search).toHaveBeenCalledWith("api.ts", 50);
  });

  it("keeps the path as written when it is ambiguous, missing or the index fails", async () => {
    search.mockResolvedValue([
      { path: "/p/a/index.ts", rel: "a/index.ts" },
      { path: "/p/b/index.ts", rel: "b/index.ts" },
    ]);
    expect(await locateInProject("/p/index.ts", "/p")).toBe("/p/index.ts");
    search.mockResolvedValue([]);
    expect(await locateInProject("/p/gone.ts", "/p")).toBe("/p/gone.ts");
    search.mockRejectedValue(new Error("no index"));
    expect(await locateInProject("/p/x.ts", "/p")).toBe("/p/x.ts");
  });
});

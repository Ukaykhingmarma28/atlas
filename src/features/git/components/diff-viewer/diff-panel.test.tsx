// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ReviewFile } from "../../lib/use-review-files";

// No Tauri here: the settings store subscribes to config changes at import,
// and the panel listens for git and file-system events.
vi.mock("@/features/settings/lib/atlas-config-api", () => ({
  updateSettings: vi.fn(),
  resetConfig: vi.fn(),
  onConfigChanged: () => Promise.resolve(() => {}),
  onConfigError: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

vi.mock("../../lib/git-review-api", () => ({
  getDiffPreview: vi.fn(async () => ({
    sources: [{ kind: "working-tree", baseRef: null, mergeBase: null }],
  })),
  getDiffFileContents: vi.fn(),
}));

const FILE: ReviewFile = {
  stat: { path: "src/long.ts", status: "modified", additions: 1, deletions: 0 },
  fileDiff: {
    name: "src/long.ts",
    hunks: [],
    additionLines: [],
    deletionLines: [],
    cacheKey: "long",
  },
  state: "ready",
  truncated: false,
} as unknown as ReviewFile;

vi.mock("../../lib/use-review-files", () => ({
  useReviewFiles: () => ({
    files: [FILE],
    stats: [FILE.stat],
    requestFile: vi.fn(),
    retry: vi.fn(),
  }),
  invalidateReviewFiles: vi.fn(),
}));

// The viewer itself renders in a shadow root off a worker pool; what matters
// here is what the panel hands it: the `overflow`, each item's fold, and the
// header tail it draws for each file.
vi.mock("./styled-code-view", () => ({
  StyledCodeView: (props: {
    options: { overflow: string };
    items: { id: string; collapsed?: boolean }[];
    renderHeaderMetadata?: (item: { id: string; collapsed?: boolean }) => ReactNode;
  }) => (
    <div data-testid="viewer" data-overflow={props.options.overflow}>
      {props.items.map((item) => (
        <div key={item.id} data-testid="item" data-collapsed={String(item.collapsed === true)}>
          {props.renderHeaderMetadata?.(item)}
        </div>
      ))}
    </div>
  ),
}));

const { DiffPanel } = await import("./diff-panel");
const { useSettingsStore } = await import("@/features/settings/stores/settings-store");
const { DEFAULT_SETTINGS } = await import("@/features/settings/lib/app-settings");
const { useLayoutStore } = await import("@/features/layout/stores/layout-store");
const { isMac } = await import("@/lib/platform");
const { useDiffPanelStore } = await import("../../stores/diff-panel-store");

const updateSettings = vi.fn((partial: Partial<typeof DEFAULT_SETTINGS>) =>
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...partial } })),
);

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DiffPanel tabId="review" repoPath="/repo" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useDiffPanelStore.setState({ viewed: {}, collapsed: {} });
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    actions: { ...useSettingsStore.getState().actions, updateSettings },
  });
});
afterEach(cleanup);

describe("DiffPanel word wrap", () => {
  it("wraps by default, from the global setting", async () => {
    expect(DEFAULT_SETTINGS.wordWrap).toBe(true);
    renderPanel();
    const viewer = await screen.findByTestId("viewer");
    expect(viewer.dataset.overflow).toBe("wrap");
    expect(screen.getByRole("button", { name: /word wrap/i }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("scrolls when the setting is off", async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, wordWrap: false } }));
    renderPanel();
    expect((await screen.findByTestId("viewer")).dataset.overflow).toBe("scroll");
  });

  it("its toggle flips the global setting, and the viewer follows", async () => {
    renderPanel();
    await screen.findByTestId("viewer");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /word wrap/i }));
    });
    expect(updateSettings).toHaveBeenCalledWith({ wordWrap: false });
    expect(screen.getByTestId("viewer").dataset.overflow).toBe("scroll");
    expect(screen.getByRole("button", { name: /word wrap/i }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});

describe("DiffPanel find (⌘F)", () => {
  const press = () => {
    const event = new KeyboardEvent("keydown", {
      code: "KeyF",
      key: "f",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  };

  it("opens the find bar while its tab is the active one", async () => {
    useLayoutStore.setState({ activeTabId: "review" });
    renderPanel();
    await screen.findByTestId("viewer");
    expect(screen.queryByRole("search")).toBeNull();
    const event = press();
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole("search", { name: "Find in diff" })).toBeTruthy();
  });

  it("leaves ⌘F to the session when the session's tab has the keyboard", async () => {
    useLayoutStore.setState({ activeTabId: "session-tab" });
    renderPanel();
    await screen.findByTestId("viewer");
    const event = press();
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("opens from its header button too", async () => {
    renderPanel();
    await screen.findByTestId("viewer");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /find in diff/i }));
    });
    expect(screen.getByRole("search", { name: "Find in diff" })).toBeTruthy();
  });
});

describe("DiffPanel viewed files", () => {
  const viewedCount = () => screen.getByText(/viewed$/).textContent;
  // Base UI's box forwards a click to its hidden native input, which is what
  // the test DOM can toggle.
  const tick = () =>
    act(() => {
      const box = screen.getAllByRole("checkbox")[0]!;
      fireEvent.click(box.parentElement!.querySelector("input")!);
    });

  it("counts files and viewed ones, and a tick folds the file", async () => {
    renderPanel();
    await screen.findByTestId("viewer");
    expect(screen.getByText("1 file")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Viewed" })).toBeTruthy();
    expect(viewedCount()).toBe("0 / 1 viewed");
    expect(screen.getByTestId("item").dataset.collapsed).toBe("false");

    tick();
    expect(viewedCount()).toBe("1 / 1 viewed");
    expect(screen.getByTestId("item").dataset.collapsed).toBe("true");
    const marks = Object.values(useDiffPanelStore.getState().viewed)[0];
    expect(Object.keys(marks ?? {})).toEqual(["src/long.ts"]);

    // Unticking opens it again.
    tick();
    expect(viewedCount()).toBe("0 / 1 viewed");
    expect(screen.getByTestId("item").dataset.collapsed).toBe("false");
  });

  it("reads as changed when the file's diff moved since it was viewed", async () => {
    renderPanel();
    await screen.findByTestId("viewer");
    tick();
    // The mark as if made against another version of the diff.
    act(() => {
      const viewed = useDiffPanelStore.getState().viewed;
      const [scope, marks] = Object.entries(viewed)[0]!;
      const mark = marks["src/long.ts"]!;
      useDiffPanelStore.setState({
        viewed: { [scope]: { "src/long.ts": { ...mark, sig: (mark.sig ?? 0) + 1 } } },
      });
    });
    expect(
      screen.getByRole("checkbox", { name: /changed since you marked it viewed/i }),
    ).toBeTruthy();
    expect(screen.getByText("Changed")).toBeTruthy();
    // Still counted: it was viewed, it just needs another look.
    expect(viewedCount()).toBe("1 / 1 viewed");
  });
});

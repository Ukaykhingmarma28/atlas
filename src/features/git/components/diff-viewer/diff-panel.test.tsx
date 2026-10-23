// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  fileDiff: { name: "src/long.ts", hunks: [], cacheKey: "long" },
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
// here is the `overflow` the panel hands it.
vi.mock("./styled-code-view", () => ({
  StyledCodeView: (props: { options: { overflow: string } }) => (
    <div data-testid="viewer" data-overflow={props.options.overflow} />
  ),
}));

const { DiffPanel } = await import("./diff-panel");
const { useSettingsStore } = await import("@/features/settings/stores/settings-store");
const { DEFAULT_SETTINGS } = await import("@/features/settings/lib/app-settings");

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

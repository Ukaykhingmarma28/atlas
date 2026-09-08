// @vitest-environment happy-dom
//
// The streaming tail must keep growing under React StrictMode.
//
// `useBlocks` coalesces its per-frame split on "a frame is already pending".
// StrictMode mounts, unmounts and remounts every component once in dev, and
// the unmount cleanup used to cancel the pending frame WITHOUT forgetting it —
// so the remounted hook saw a frame "pending" forever, every later source
// change early-returned, and the transcript sat on the first chunk until the
// turn settled and painted the whole answer in one frame. Production React
// never double-invokes effects, which is why the installed app streamed fine
// while every `tauri dev` run looked broken — and why it took a while to see.

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// The renderer's dependencies are pinned to trivial stand-ins: the property
// under test is whether the tail RE-RENDERS, not what markdown becomes.
vi.mock("@/lib/markdown-cache", () => ({
  CachedMarkdown: ({ source }: { source: string }) => <div data-settled>{source}</div>,
  transientWorkerAvailable: () => false,
  parseTransientOffThread: async () => null,
}));
vi.mock("@/lib/markdown-render", () => ({
  parseMarkdown: (src: string) => `<p>${src}</p>`,
}));

import { StreamingMarkdown } from "./streaming-markdown";

/** happy-dom's rAF is not tied to anything we can await; a macrotask stand-in
 *  lets a test flush "one frame" deterministically. */
let frames: Array<() => void> = [];
beforeEach(() => {
  cleanup();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(() => cb(performance.now()));
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames[id - 1] = () => {};
  });
});
afterEach(() => vi.unstubAllGlobals());

const flushFrames = async () => {
  await act(async () => {
    const pending = frames.splice(0);
    for (const f of pending) f();
  });
};

describe("StreamingMarkdown under StrictMode", () => {
  it("keeps rendering new chunks after the StrictMode remount", async () => {
    const view = render(
      <StrictMode>
        <StreamingMarkdown source="Here's a" streaming />
      </StrictMode>,
    );
    await flushFrames();
    expect(view.container.textContent).toContain("Here's a");

    // Chunks arrive: the tail must follow them, frame by frame.
    view.rerender(
      <StrictMode>
        <StreamingMarkdown source="Here's a dense pass over the markdown surface" streaming />
      </StrictMode>,
    );
    await flushFrames();
    expect(view.container.textContent).toContain("dense pass over the markdown surface");

    view.rerender(
      <StrictMode>
        <StreamingMarkdown
          source={"Here's a dense pass over the markdown surface\n\n## Lists\n\n- one"}
          streaming
        />
      </StrictMode>,
    );
    await flushFrames();
    expect(view.container.textContent).toContain("- one");
  });

  it("settles into cached blocks when streaming ends", async () => {
    const view = render(
      <StrictMode>
        <StreamingMarkdown source={"First\n\nSecond"} streaming />
      </StrictMode>,
    );
    await flushFrames();
    view.rerender(
      <StrictMode>
        <StreamingMarkdown source={"First\n\nSecond"} streaming={false} />
      </StrictMode>,
    );
    await flushFrames();
    expect(view.container.querySelectorAll("[data-settled]").length).toBe(2);
  });
});

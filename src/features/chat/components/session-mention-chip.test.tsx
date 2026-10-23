// @vitest-environment happy-dom
//
// Where a session chip's record may come from. A video `@file` chip's hover
// preview allow-lists the file's directory for the asset protocol, so only a
// chip the user picked or dropped may preview: one rebuilt from typed or
// pasted text shows its icon and name and asks Rust for nothing. HTML pasted
// into the composer is untrusted, so a chip in it is either a mention this run
// minted or a plain path chip, never a record carried in from outside, and a
// payload that is not a JSON object pastes as text instead of breaking the
// serializer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() =>
  vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (p: string) => `asset://localhost${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { createRef } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";

import { resetMentionRegistryForTests, rememberMention } from "../lib/mention-registry";
import type { MentionData } from "../lib/mentions";
import { ChatInput, type ChatInputHandle } from "./chat-input";
import { chipFromHTML, pickedChip } from "./session-mention-chip";

const CLIP: MentionData = {
  kind: "file",
  id: "/abs/media/clip.mp4",
  displayName: "/abs/media/clip.mp4",
  absPath: "/abs/media/clip.mp4",
};

beforeEach(() => {
  invoke.mockClear();
  resetMentionRegistryForTests();
});
afterEach(cleanup);

function mount(initialValue = "") {
  const ref = createRef<ChatInputHandle>();
  const view = render(<ChatInput ref={ref} initialValue={initialValue} />);
  const pm = view.container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
  return { ref, editor: pm.editor, container: view.container };
}

async function hoverChip(container: HTMLElement) {
  // Node views mount through React after the editor's own render.
  const chip = await waitFor(() => {
    const el = container.querySelector(".atlas-mention-chip");
    expect(el).not.toBeNull();
    return el!;
  });
  fireEvent.mouseEnter(chip);
  // The preview loads after a 200 ms hover.
  await act(() => new Promise((r) => setTimeout(r, 300)));
}

const allowCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === "asset_allow_dir");

describe("media preview provenance", () => {
  it("a chip rebuilt from typed text previews nothing and allow-lists nothing", async () => {
    const { ref, container } = mount("look at @file:/abs/media/clip.mp4");
    expect(ref.current!.getMentions()).toEqual([CLIP]);
    await hoverChip(container);
    expect(allowCalls()).toEqual([]);
    expect(document.querySelector(".atlas-mention-preview")).toBeNull();
  });

  it("a picked chip previews, and its flag never leaves the composer", async () => {
    const { ref, container } = mount();
    act(() => ref.current!.insertMention(CLIP));
    expect(ref.current!.getMentions()).toEqual([CLIP]);
    await hoverChip(container);
    expect(allowCalls()).toEqual([["asset_allow_dir", { path: "/abs/media" }]]);
  });

  it("a picked chip restored from its text is still picked", async () => {
    rememberMention(pickedChip(CLIP));
    const { container } = mount("again @file:/abs/media/clip.mp4");
    await hoverChip(container);
    expect(allowCalls()).toHaveLength(1);
  });
});

describe("chips pasted as HTML", () => {
  const span = (payload: string, text = "x") =>
    `<span data-composer-chip="sessionMention" data-chip='${payload}'>${text}</span>`;

  it("drops a forged picked flag: the chip is a plain path chip", async () => {
    const { ref, editor, container } = mount();
    act(() => {
      editor.view.pasteHTML(span(JSON.stringify({ ...CLIP, picked: true, extra: 1 })));
    });
    expect(ref.current!.getMentions()).toEqual([CLIP]);
    await hoverChip(container);
    expect(allowCalls()).toEqual([]);
  });

  it("takes the minted record when the HTML names one", () => {
    rememberMention(pickedChip(CLIP));
    expect(chipFromHTML({ ...CLIP })).toEqual({ ...CLIP, picked: true });
  });

  it("pastes any other kind it did not mint as text", () => {
    expect(
      chipFromHTML({ kind: "past_session", id: "s1", displayName: "x", sessionId: "s1" }),
    ).toBeNull();
    expect(chipFromHTML({ kind: "nope", id: "1" })).toBeNull();
    expect(chipFromHTML({ kind: "file", id: "/a", displayName: "/a", absPath: "/b" })).toBeNull();
  });

  it.each(["null", "[1,2]", "3", '"text"', "{not json"])(
    "pastes a %s payload as text, and the value still serializes",
    (payload) => {
      const { ref, editor } = mount();
      act(() => {
        editor.view.pasteHTML(span(payload, "@file:gone"));
      });
      expect(ref.current!.getMentions()).toEqual([]);
      expect(ref.current!.getValue()).toBe("@file:gone");
    },
  );
});

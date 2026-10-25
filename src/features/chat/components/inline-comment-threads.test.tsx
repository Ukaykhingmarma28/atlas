// @vitest-environment happy-dom
//
// The threads under a row: nothing until there is a thread or a composer,
// a composer where a compose request points, Enter to post with the passage
// quoted the way the server stores it, replies under the root, and a
// resolved thread folded to one line.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { Comment } from "@/features/artifacts/lib/comments-api";
import { selectionCommentBody } from "@/features/artifacts/lib/selection-comment";

import { InlineCommentThreads } from "./inline-comment-threads";
import { useChatCommentsStore } from "../stores/chat-comments-store";

const TAB = "chat-a";
const KEY = "msg-1";
const ROW = "a:deadbeef:0";

const post = vi.fn(async () => {});
const resolve = vi.fn(async () => {});
const remove = vi.fn(async () => {});
const directory = { byId: new Map(), currentUserId: "me" };

function comment(partial: Partial<Comment> & { id: string }): Comment {
  return {
    sessionId: "s",
    anchorKind: "message",
    anchorId: ROW,
    parentId: null,
    authorId: "me",
    guestName: null,
    body: "A comment",
    mentions: [],
    createdAt: "2026-10-26T00:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...partial,
  };
}

function seed(comments: Comment[]) {
  useChatCommentsStore.setState({
    byTab: {
      [TAB]: {
        target: null,
        entries: [],
        anchors: {
          rowIdByChatKey: new Map([[KEY, { rowId: ROW, anchorKind: "message" as const }]]),
          chatKeyByRowId: new Map([[ROW, KEY]]),
          ordered: [],
        },
        byAnchor: { [ROW]: comments },
        byChatKey: { [KEY]: comments },
        session: [],
        commentCount: comments.length,
        actions: { post, resolve, remove },
        directory,
      },
    },
    compose: {},
    focus: {},
  });
}

function mount() {
  const proseRef = createRef<HTMLDivElement>();
  const view = render(
    <div>
      <div ref={proseRef}>
        <p>Scope it to the usage page.</p>
      </div>
      <InlineCommentThreads tabId={TAB} chatKey={KEY} proseRef={proseRef} />
    </div>,
  );
  return view;
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue(undefined);
  resolve.mockReset();
  resolve.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("inline comment threads", () => {
  it("renders nothing without a thread or a compose request", () => {
    seed([]);
    const { container } = mount();
    expect(container.querySelector("[data-comment-threads]")).toBeNull();
  });

  it("opens a composer where the compose request points, and posts the passage with the note", async () => {
    seed([]);
    mount();
    act(() =>
      useChatCommentsStore.getState().actions.startCompose(TAB, KEY, "Scope it to the usage page."),
    );
    const field = await screen.findByPlaceholderText("Comment on this passage…");
    expect(screen.getByRole("blockquote", { name: "Selected passage" }).textContent).toBe(
      "Scope it to the usage page.",
    );
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "  Why only usage?  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "message",
        ROW,
        selectionCommentBody("Scope it to the usage page.", "Why only usage?"),
        null,
      ),
    );
    await waitFor(() => expect(useChatCommentsStore.getState().compose[TAB]).toBeUndefined());
  });

  it("Escape puts the composer away; a request for another row is not this row's", () => {
    seed([]);
    mount();
    act(() => useChatCommentsStore.getState().actions.startCompose(TAB, "other", null));
    expect(screen.queryByPlaceholderText("Comment…")).toBeNull();
    act(() => useChatCommentsStore.getState().actions.startCompose(TAB, KEY, null));
    const field = screen.getByPlaceholderText("Comment…");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(useChatCommentsStore.getState().compose[TAB]).toBeUndefined();
    expect(screen.queryByPlaceholderText("Comment…")).toBeNull();
  });

  it("keeps the draft when the post fails", async () => {
    post.mockRejectedValueOnce(new Error("offline"));
    seed([]);
    mount();
    act(() => useChatCommentsStore.getState().actions.startCompose(TAB, KEY, null));
    const field = screen.getByPlaceholderText("Comment…") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Keep me" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(post).toHaveBeenCalled());
    await waitFor(() => expect(field.disabled).toBe(false));
    expect(field.value).toBe("Keep me");
    expect(useChatCommentsStore.getState().compose[TAB]?.chatKey).toBe(KEY);
  });

  it("draws a thread with its passage, replies under the root, and posts a reply to it", async () => {
    const root = comment({
      id: "c1",
      body: selectionCommentBody("usage page", "Why only usage?"),
    });
    const reply = comment({ id: "c2", parentId: "c1", body: "Billing too.", authorId: "them" });
    seed([root, reply]);
    mount();
    expect(screen.getByRole("blockquote", { name: "Commented passage" }).textContent).toBe(
      "usage page",
    );
    expect(screen.getByText("Why only usage?")).toBeTruthy();
    expect(screen.getByText("Billing too.")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const field = screen.getByPlaceholderText("Reply…");
    fireEvent.change(field, { target: { value: "Agreed" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(post).toHaveBeenCalledWith("message", ROW, "Agreed", "c1"));
  });

  it("folds a resolved thread to one line and reopens it", () => {
    seed([
      comment({ id: "c1", resolvedAt: "2026-10-26T01:00:00.000Z", resolvedBy: "me" }),
      comment({ id: "c2", parentId: "c1", body: "Done." }),
    ]);
    mount();
    const folded = screen.getByRole("button", { name: /Resolved · 2 comments/ });
    expect(screen.queryByText("Done.")).toBeNull();
    fireEvent.click(folded);
    expect(screen.getByText("Done.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(resolve).toHaveBeenCalledWith("c1", false);
  });

  it("offers Delete on your own comments only, and hides a deleted root", () => {
    seed([
      comment({ id: "mine" }),
      comment({ id: "theirs", authorId: "them", body: "Not yours" }),
      comment({ id: "gone", body: null, deletedAt: "2026-10-26T02:00:00.000Z" }),
    ]);
    mount();
    expect(screen.getAllByRole("button", { name: "Delete comment" })).toHaveLength(1);
    expect(screen.getAllByRole("region", { name: "Comment thread" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(remove).toHaveBeenCalledWith("mine");
  });
});

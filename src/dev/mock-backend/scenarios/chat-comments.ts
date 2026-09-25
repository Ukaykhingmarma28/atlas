// A shared chat: the prompt and the response both carry cloud comments, so the
// action bars render with the comment pill in them. The layout to review is
// the bar under each node — pill flush with the bubble's edge on the prompt,
// under the first line on the response.

import type { Scenario } from "../types";
import { mockComment } from "../fixtures/artifacts";
import { text, user, t } from "../fixtures/chat";
import { setSeedTranscript } from "../fake-agent";

const transcript = [user("hello world", t(0)), text("Hey! 👋 How can I help you today?", t(1))];
const SESSION = "as-mock-chat";
const PROMPT_ROW = "am-prompt-1";
const RESPONSE_ROW = "am-response-1";

const comments = [
  mockComment({ id: "cc_1", sessionId: SESSION, anchorId: PROMPT_ROW, body: "hello" }),
  mockComment({ id: "cc_2", sessionId: SESSION, anchorId: PROMPT_ROW, body: "again" }),
  mockComment({ id: "cc_3", sessionId: SESSION, anchorId: RESPONSE_ROW, body: "nice" }),
  mockComment({ id: "cc_4", sessionId: SESSION, anchorId: RESPONSE_ROW, body: "is it?" }),
  mockComment({
    id: "cc_5",
    sessionId: SESSION,
    anchorId: RESPONSE_ROW,
    parentId: "cc_4",
    body: "yes",
    authorId: "user_bob",
  }),
];

export const chatComments: Scenario = {
  name: "chat-comments",
  description: "A shared chat with comments on the prompt and the response.",
  init: () => setSeedTranscript(transcript),
  commands: {
    chat_comment_target: () => ({
      remoteProjectId: "rw_8c41f20b",
      sessionId: SESSION,
      entries: [
        { rowId: PROMPT_ROW, kind: "prompt", turnSeq: 1, nativeId: "prompt-1-x", toolName: null },
        // The response's native id is the wire message id, as capture records it.
        {
          rowId: RESPONSE_ROW,
          kind: "response",
          turnSeq: 1,
          nativeId: transcript[1].id,
          toolName: null,
        },
      ],
    }),
    artifacts_cloud_comments: ({ sessionId }) => {
      if (String(sessionId) !== SESSION) return { byAnchor: {}, session: [] };
      const byAnchor: Record<string, typeof comments> = {};
      for (const c of comments) (byAnchor[c.anchorId] ??= []).push(c);
      return { byAnchor, session: [] };
    },
  },
};

// A stand-in for the agent host. Sessions are kept here so `agents_snapshot*`
// agree with what was streamed, and a scenario's transcript reaches the chat
// the way a real one does: as `atlas:agents` deltas.

import { emit } from "@tauri-apps/api/event";
import type { AgentInfo, PermissionDecision, PermissionOptionRef } from "@/types/acp";
import type {
  AgentDelta,
  SessionInit,
  SessionKey,
  SessionMessage,
  SessionSnapshot,
  ToolCall,
} from "@/types/agents";
import type { TypedHandlers, Unit } from "./types";
import { text, tool, tools } from "./fixtures/chat";
import {
  askUserQuestionMulti,
  askUserQuestionSingle,
  exitPlanOptions,
  LONG_COMMAND,
  LONG_COMMAND_RESULT,
  PLAN_MARKDOWN,
  permissionToolCall,
  standardOptions,
} from "./fixtures/permission";

interface FakeSession {
  key: SessionKey;
  cwd: string;
  pluginId: string;
  messages: SessionMessage[];
}

const sessions = new Map<string, FakeSession>();
let seq = 0;

/** What a new session replays once it is bound. Set by a scenario. */
let seedTranscript: SessionMessage[] = [];
export function setSeedTranscript(messages: SessionMessage[]): void {
  seedTranscript = messages;
}

function latest(): FakeSession | undefined {
  const all = [...sessions.values()];
  return all[all.length - 1];
}

const at = (s: FakeSession) => ({ agent_id: s.key.agent_id, session_id: s.key.session_id });

export function sendDelta(delta: AgentDelta): Promise<void> {
  return emit("atlas:agents", delta);
}

function sessionOrThrow(key: SessionKey): FakeSession {
  const s = sessions.get(key.session_id);
  if (!s) throw new Error(`session ${key.session_id} not found`);
  return s;
}

function snapshot(s: FakeSession, withMessages: boolean): SessionSnapshot {
  const now = new Date().toISOString();
  return {
    ...at(s),
    cwd: s.cwd,
    plugin_id: s.pluginId,
    status: "idle",
    current_mode: null,
    current_model: "mock-model",
    available_modes: [],
    available_models: [{ id: "mock-model", name: "Mock model" }],
    available_commands: [],
    config_options: [],
    prompt_image_supported: true,
    plan: [],
    messages: withMessages ? s.messages : [],
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
    created_at: now,
    updated_at: now,
  };
}

/** Stream `messages` into the first live session, in order. */
export async function playTranscript(messages: SessionMessage[], gapMs = 0): Promise<void> {
  const s = latest();
  if (!s) {
    console.warn("[mock-backend] playTranscript: no session bound yet");
    return;
  }
  for (const message of messages) {
    s.messages.push(message);
    await sendDelta({ kind: "message_appended", ...at(s), message });
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
}

/** Update one tool call in place (status, output) — for live-turn scenarios. */
export function upsertToolCall(messageId: string, toolCall: ToolCall): Promise<void> {
  const s = latest();
  if (!s) return Promise.resolve();
  return sendDelta({
    kind: "tool_call_upserted",
    ...at(s),
    message_id: messageId,
    tool_call: toolCall,
  });
}

/** Stream a chunk of live output into a running tool call. */
export function appendToolOutput(
  messageId: string,
  toolCallId: string,
  delta: string,
): Promise<void> {
  const s = latest();
  if (!s) return Promise.resolve();
  return sendDelta({
    kind: "tool_call_output_chunk",
    ...at(s),
    message_id: messageId,
    tool_call_id: toolCallId,
    delta,
  });
}

export function setStatus(status: "idle" | "running" | "waiting" | "error"): Promise<void> {
  const s = latest();
  if (!s) return Promise.resolve();
  return sendDelta({ kind: "status", ...at(s), status });
}

/** End the turn the way the real projector does — a `turn_finished` terminal,
 *  not a bare status flip. The store only freezes turn-end state (the turn's
 *  "Worked for" time, its files footer, next-step chips) on the terminal, so a
 *  mock that just went idle never showed any of it. */
export function finishTurn(): Promise<void> {
  const s = latest();
  if (!s) return Promise.resolve();
  return sendDelta({ kind: "turn_finished", ...at(s), stop_reason: "end_turn", turn_seq: 0 });
}

// ── Permission requests ──────────────────────────────────────────────────
//
// The real backend never raises `permission_request` out of nowhere: the
// tool call it names already exists in the thread (created "pending", then
// `WaitingForConfirmation`), and `session/request_permission` refers to it by
// id (`atlas-agent-delta/src/projector.rs::permission_requested`). So a
// trigger here first appends that pending tool call to the transcript, same
// as a real turn would, then emits the `permission_request` delta pointing at
// it — the same channel and payload shape `atlas-agent-delta::project`
// builds (see `fixtures/permission.ts`). Resolving it later updates that same
// tool call and replies in the transcript, so accept/reject are visible
// there too, not just in the modal closing.

function isAllowKind(kind: string): boolean {
  return kind === "allow_once" || kind === "allow_always";
}

interface OpenPermission {
  agentId: string;
  sessionId: string;
  messageId: string;
  toolCall: ToolCall;
  options: PermissionOptionRef[];
  /** What the transcript tool call's `result` becomes once resolved. */
  result: (allowed: boolean) => string;
  /** A follow-up assistant line, or `null` to stay silent — used by the
   *  multi-question variant, whose answer already talks back through the
   *  ordinary `agents_send` echo once its composed text is sent. */
  reply: (decision: PermissionDecision, option: PermissionOptionRef | null) => string | null;
}

const openPermissions = new Map<string, OpenPermission>();

async function raisePermission(opts: {
  transcriptCall: ToolCall;
  title: string;
  kind: string;
  rawInput: unknown;
  options: PermissionOptionRef[];
  result: OpenPermission["result"];
  reply: OpenPermission["reply"];
}): Promise<void> {
  const s = latest();
  if (!s) {
    console.warn("[mock-backend] requestPermission: no session bound yet");
    return;
  }
  await setStatus("running");
  const message = tools([opts.transcriptCall]);
  await playTranscript([message]);
  await setStatus("waiting");

  const requestId = `perm-req-${++seq}`;
  openPermissions.set(requestId, {
    agentId: s.key.agent_id,
    sessionId: s.key.session_id,
    messageId: message.id,
    toolCall: opts.transcriptCall,
    options: opts.options,
    result: opts.result,
    reply: opts.reply,
  });
  await sendDelta({
    kind: "permission_request",
    ...at(s),
    request_id: requestId,
    tool_call: permissionToolCall({
      id: opts.transcriptCall.id,
      title: opts.title,
      kind: opts.kind,
      rawInput: opts.rawInput,
    }),
    options: opts.options,
  });
}

async function resolvePermission(
  agentId: string,
  sessionId: string,
  requestId: string,
  decision: PermissionDecision,
): Promise<void> {
  const open = openPermissions.get(requestId);
  openPermissions.delete(requestId);
  // Mirrors the real `permission_resolved` delta (App.tsx's `popPermission`
  // case) — redundant with the modal's own optimistic pop, but keeps the wire
  // shape faithful for anything else that might be watching it.
  await sendDelta({
    kind: "permission_resolved",
    agent_id: agentId,
    session_id: sessionId,
    request_id: requestId,
  });
  if (!open) return;

  const option =
    decision.kind === "selected"
      ? (open.options.find((o) => o.optionId === decision.option_id) ?? null)
      : null;
  const allowed = !!option && isAllowKind(option.kind);

  await upsertToolCall(open.messageId, {
    ...open.toolCall,
    status: allowed ? "completed" : "failed",
    result: open.result(allowed),
  });

  const line = open.reply(decision, option);
  if (line) await playTranscript([text(line, new Date().toISOString())]);
  await finishTurn();
}

let permSeq = 0;
const permId = () => `perm-tc-${++permSeq}`;

/** Plain command approval — the standard case (`__atlasMock.actions.requestPermission`). */
export function requestPermission(): Promise<void> {
  const id = permId();
  const command = "rm -rf .turbo dist";
  return raisePermission({
    transcriptCall: tool.run(command, { id, status: "pending" }),
    title: command,
    kind: "execute",
    rawInput: { command },
    options: standardOptions("this command"),
    result: (allowed) => (allowed ? "removed .turbo and dist\n" : "Rejected by user."),
    reply: (decision, option) =>
      decision.kind === "cancelled"
        ? "Okay — I won't run that."
        : option && isAllowKind(option.kind)
          ? "Done — cleaned the build output."
          : "Understood — I'll leave the build output alone.",
  });
}

/** A long, multi-line command — checks the preview wraps instead of
 *  overflowing (`__atlasMock.actions.requestPermissionLongArgs`). */
export function requestPermissionLongArgs(): Promise<void> {
  const id = permId();
  return raisePermission({
    transcriptCall: tool.run("run a repo-wide focused-test sweep", { id, status: "pending" }),
    title: "Run shell pipeline",
    kind: "execute",
    rawInput: { command: LONG_COMMAND },
    options: standardOptions("shell pipelines like this"),
    result: (allowed) => (allowed ? LONG_COMMAND_RESULT : "Rejected by user."),
    reply: (decision, option) =>
      decision.kind === "cancelled"
        ? "Okay — skipping the sweep."
        : option && isAllowKind(option.kind)
          ? "Ran it — see the output above."
          : "Understood — I'll skip the sweep.",
  });
}

/** ExitPlanMode's two-panel review (`__atlasMock.actions.requestPermissionPlan`). */
export function requestPermissionPlan(): Promise<void> {
  const id = permId();
  return raisePermission({
    transcriptCall: tool.other("ExitPlanMode", { plan: PLAN_MARKDOWN }, { id, status: "pending" }),
    title: "Exit plan mode",
    kind: "think",
    rawInput: { plan: PLAN_MARKDOWN },
    options: exitPlanOptions(),
    result: (allowed) => (allowed ? "Plan approved." : "Plan rejected — staying in plan mode."),
    reply: (decision, option) =>
      decision.kind === "cancelled"
        ? "Sticking with plan mode."
        : option && isAllowKind(option.kind)
          ? "Thanks — I'll start implementing the plan."
          : "Okay, I'll keep refining the plan.",
  });
}

/** Claude's `AskUserQuestion`, one single-select question — resolves through
 *  a real ACP option when the answer names a choice unambiguously
 *  (`__atlasMock.actions.requestPermissionQuestion`). */
export function requestPermissionQuestion(): Promise<void> {
  const id = permId();
  const q = askUserQuestionSingle();
  return raisePermission({
    transcriptCall: tool.other("AskUserQuestion", q.rawInput, { id, status: "pending" }),
    title: "Ask a question",
    kind: "other",
    rawInput: q.rawInput,
    options: q.options,
    result: (allowed) => (allowed ? "Answered." : "Cancelled."),
    reply: (decision, option) =>
      decision.kind === "cancelled"
        ? "Okay — I'll hold off."
        : option
          ? `Using ${option.name}.`
          : null,
  });
}

/** Claude's `AskUserQuestion`, two questions (one multi-select) — no single
 *  option names the combination, so it always composes a free-text reply
 *  (`__atlasMock.actions.requestPermissionQuestionMulti`). */
export function requestPermissionQuestionMulti(): Promise<void> {
  const id = permId();
  const q = askUserQuestionMulti();
  return raisePermission({
    transcriptCall: tool.other("AskUserQuestion", q.rawInput, { id, status: "pending" }),
    title: "Ask a question",
    kind: "other",
    rawInput: q.rawInput,
    options: q.options,
    result: (allowed) => (allowed ? "Answered." : "Cancelled."),
    // Silent either way: a composed answer is sent as an ordinary message and
    // gets the usual `agents_send` echo; Escape needs no narration.
    reply: () => null,
  });
}

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface AgentResponses {
  agents_spawn: AgentInfo;
  agents_new_session: SessionInit;
  agents_snapshot: SessionSnapshot;
  agents_snapshot_meta: SessionSnapshot;
  agents_list_running: AgentInfo[];
  agents_replay_transcript: SessionMessage[];
  agents_drop_session: Unit;
  agents_cancel: Unit;
  agents_respond_permission: Unit;
  agents_send: Unit;
}

export const agentHandlers: TypedHandlers<AgentResponses> = {
  agents_spawn: ({ pluginId }): AgentInfo => ({
    agent_id: `agent-${pluginId}`,
    spec_id: pluginId,
    display_name: "Atlas Agent",
  }),
  agents_new_session: ({ agentId, cwd }): SessionInit => {
    const key = { agent_id: agentId, session_id: `sess-${++seq}` };
    const s: FakeSession = {
      key,
      cwd,
      pluginId: String(agentId).replace(/^agent-/, ""),
      messages: [],
    };
    sessions.set(key.session_id, s);
    if (seedTranscript.length) {
      // After the frontend has stored the binding.
      setTimeout(() => void playTranscript(seedTranscript), 50);
    }
    return { key, current_mode: null, available_modes: [] };
  },
  // Rust answers an unknown key with `Err`, never `null`.
  agents_snapshot: ({ key }) => snapshot(sessionOrThrow(key), true),
  agents_snapshot_meta: ({ key }) => snapshot(sessionOrThrow(key), false),
  agents_list_running: () => [],
  agents_replay_transcript: () => [],
  agents_drop_session: () => null,
  agents_cancel: () => setStatus("idle"),
  agents_respond_permission: ({ agentId, sessionId, requestId, decision }) => {
    void resolvePermission(agentId, sessionId, requestId, decision);
    return null;
  },
  // Echo the prompt back so the composer loop is exercisable.
  agents_send: async ({ key, text }) => {
    const s = sessions.get(key.session_id);
    if (!s) return null;
    const now = () => new Date().toISOString();
    await setStatus("running");
    const reply: SessionMessage = {
      id: `m-${++seq}`,
      role: "assistant",
      mode: "text",
      content: `(mock) You said: ${text}`,
      tool_calls: [],
      timestamp: now(),
    };
    setTimeout(() => {
      void playTranscript([reply]).then(() => finishTurn());
    }, 400);
    return null;
  },
};

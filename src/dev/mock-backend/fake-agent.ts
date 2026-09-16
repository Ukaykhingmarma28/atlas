// A stand-in for the agent host. Sessions are kept here so `agents_snapshot*`
// agree with what was streamed, and a scenario's transcript reaches the chat
// the way a real one does: as `atlas:agents` deltas.

import { emit } from "@tauri-apps/api/event";
import type { AgentInfo } from "@/types/acp";
import type {
  AgentDelta,
  SessionInit,
  SessionKey,
  SessionMessage,
  SessionSnapshot,
  ToolCall,
} from "@/types/agents";
import type { MockHandlers } from "./types";

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

export const agentHandlers: MockHandlers = {
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
  agents_snapshot: ({ key }) => {
    const s = sessions.get(key.session_id);
    return s ? snapshot(s, true) : null;
  },
  agents_snapshot_meta: ({ key }) => {
    const s = sessions.get(key.session_id);
    return s ? snapshot(s, false) : null;
  },
  agents_list_running: () => [],
  agents_replay_transcript: () => [],
  agents_drop_session: () => null,
  agents_cancel: () => setStatus("idle"),
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
      void playTranscript([reply]).then(() => setStatus("idle"));
    }, 400);
    return null;
  },
};

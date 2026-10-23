import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Small, independent wire-shape pins. The first four are regressions found by
 * hand while auditing the app for pre-existing bugs (none is about the theme
 * system):
 *
 * 1. `comms_send`'s Rust `SendReceipt` is `#[serde(rename_all = "camelCase")]`
 *    (wire key `clientMsgId`), but the frontend declared the invoke result as
 *    `{ client_msg_id }` — a key that never arrives.
 * 2. `SessionChatThread` had no `checkpoint_scope` field at all, so the key the
 *    frontend always sends was silently dropped by serde and a thread's
 *    checkpoint scope never survived a reload.
 * 3. Rust's `EventKind` enum can send `failure` and `architecture`; the
 *    frontend's `EventKind` union didn't list them.
 * 4. Rust's `GraphEdge` sends a `weight` field the frontend's `MemoryEdge`
 *    interface didn't declare.
 *
 * Two more joined later, in the same spirit: #5, a call start that named no
 * provider; and #6, a chat message's author kind (a person, or an incoming
 * webhook), which neither side's types carried.
 *
 * And #7, the thread-history surface (`history-api.ts` ↔ `agent_host.rs` /
 *    `agents.rs`): every row and project struct field for field, after the
 *    camelCase rename, and every `threads_*` command's argument keys. A
 *    renamed field (`liveElsewhere` gating the composer's send hold) or a
 *    renamed argument (`threads_sync_project`'s `cwd`) compiles on both sides
 *    and silently arrives as `undefined` / fails to deserialize.
 *
 * #11 pins a cloud comment's shape: the TS `Comment` the threads render and
 *    the Rust `atlas_artifacts::model::Comment` that deserializes the server's
 *    rows, field for field, plus their `AnchorKind`s. The server's own
 *    `ArtifactComment` (in the separate server repository's contracts
 *    package) is not reachable from this repo or its CI, so it is not pinned
 *    here; a field the server adds is dropped by serde without an error,
 *    which is exactly why the two sides this repo owns must at least agree.
 * #12 pins the cite chip (`MentionCitedText`) to the `compose_prompt`
 *    variant it deserializes as (`MentionSpec::CitedText`): a renamed field
 *    there arrives as `None`, and the agent silently loses the note or row.
 *

 * `save_app_state` / `bootstrap_app_state` payload and generalises over many
 * struct pairs), these four are one-off, unrelated commands — plain regression
 * pins on source text rather than a shared parsing framework, so each failure
 * message names the exact bug instead of a generic set difference.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

/** The `{ ... }` body of the first `pub struct <name> { ... }` (or `enum`) in
 *  `source`, plus whatever `#[...]` attributes sit directly above it. */
function rustItem(
  source: string,
  kind: "struct" | "enum",
  name: string,
): { attrs: string; body: string } {
  const re = new RegExp(`((?:^#\\[[^\\]]*\\]\\n)*)pub ${kind} ${name}\\s*\\{`, "m");
  const m = re.exec(source);
  if (!m) throw new Error(`Rust ${kind} ${name} not found — the source moved`);
  const bodyStart = m.index + m[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
  }
  return { attrs: m[1], body: source.slice(bodyStart, i - 1) };
}

/** Field names of a `pub struct { pub? field: Type, ... }` body (`pub` on
 *  each field is optional — several structs here keep their fields crate-private). */
function rustStructFields(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s*(?:pub\s+)?(\w+):\s*.+,?\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Variant names of a `pub enum { Variant, ... }` body, dropping any
 *  `#[serde(other)]` catch-all (it has no wire representation of its own). */
function rustEnumVariants(body: string): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("//")) continue;
    if (line.startsWith("#[")) {
      if (/serde\(other\)/.test(line)) skipNext = true;
      continue;
    }
    const m = /^(\w+)\s*,?\s*$/.exec(line);
    if (m) {
      if (!skipNext) out.push(m[1]);
      skipNext = false;
    }
  }
  return out;
}

const pascalToSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** Top-level property names of the first `interface <name> { ... }` in `source`. */
function tsInterfaceProps(source: string, name: string): string[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const header = new RegExp(`interface\\s+${name}\\s*\\{`).exec(clean);
  if (!header) throw new Error(`TS interface ${name} not found — the source moved`);
  const bodyStart = header.index + header[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < clean.length && depth > 0; i++) {
    if (clean[i] === "{") depth++;
    else if (clean[i] === "}") depth--;
  }
  const body = clean.slice(bodyStart, i - 1);
  const out: string[] = [];
  let nest = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const prop = nest === 0 ? /^(\w+)\??\s*:/.exec(line) : null;
    if (prop) out.push(prop[1]);
    for (const ch of line) {
      if (ch === "{") nest++;
      else if (ch === "}") nest--;
    }
  }
  return out;
}

/** String-literal members of a `export type <name> = | "a" | "b" | ...;` union. */
function tsUnionLiterals(source: string, name: string): string[] {
  const re = new RegExp(`type\\s+${name}\\s*=([\\s\\S]*?);`);
  const m = re.exec(source);
  if (!m) throw new Error(`TS union ${name} not found — the source moved`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("comms_send ↔ SendReceipt (#1)", () => {
  const rust = read("src-tauri", "src", "commands", "comms.rs");
  const ts = read("src", "features", "comms", "lib", "comms-api.ts");

  it("SendReceipt is camelCase on the wire", () => {
    const { attrs, body } = rustItem(rust, "struct", "SendReceipt");
    expect(attrs).toMatch(/rename_all\s*=\s*"camelCase"/);
    expect(rustStructFields(body)).toEqual(["client_msg_id"]);
  });

  it("the frontend reads the camelCase key, not the Rust field name", () => {
    // The regression: this used to say `{ client_msg_id: string }`, a key
    // `#[serde(rename_all = "camelCase")]` never puts on the wire.
    expect(ts).toMatch(/invoke<\{\s*clientMsgId:\s*string\s*\}>\("comms_send"/);
    expect(ts).not.toMatch(/invoke<\{\s*client_msg_id:\s*string\s*\}>\("comms_send"/);
  });
});

describe("session_chat_thread_get ↔ checkpointScope (#2)", () => {
  const rust = read("src-tauri", "src", "commands", "session_chat_sessions.rs");
  const ts = read("src", "features", "artifacts", "lib", "session-chat-api.ts");

  it("SessionChatThread persists checkpoint_scope", () => {
    const { body } = rustItem(rust, "struct", "SessionChatThread");
    // The regression: this field didn't exist, so serde silently dropped the
    // key the frontend always sends and a save-then-load round trip lost it.
    expect(rustStructFields(body)).toContain("checkpoint_scope");
  });

  it("the frontend wire type has the matching camelCase field", () => {
    expect(tsInterfaceProps(ts, "SessionChatThreadWire")).toContain("checkpointScope");
  });
});

describe("EventKind ↔ shared-memory-api EventKind (#3)", () => {
  const rust = read("crates", "atlas-memory", "src", "record.rs");
  const ts = read("src", "features", "memory", "lib", "shared-memory-api.ts");

  it("every Rust EventKind variant has a TS union member", () => {
    const { attrs, body } = rustItem(rust, "enum", "EventKind");
    expect(attrs).toMatch(/rename_all\s*=\s*"snake_case"/);
    const rustWire = rustEnumVariants(body).map(pascalToSnake);
    // Floor against a vacuous pass — this is the regression's own two kinds.
    expect(rustWire).toEqual(expect.arrayContaining(["failure", "architecture"]));

    const tsWire = tsUnionLiterals(ts, "EventKind");
    expect(rustWire.filter((k) => !tsWire.includes(k))).toEqual([]);
  });
});

describe("MemoryEdge ↔ GraphEdge (#4)", () => {
  const rust = read("src-tauri", "src", "commands", "memory_graph.rs");
  const ts = read("src", "features", "memory", "components", "memory-graph-canvas.tsx");

  it("every GraphEdge field is on the frontend's MemoryEdge", () => {
    const { body } = rustItem(rust, "struct", "GraphEdge");
    const rustFields = rustStructFields(body);
    // Floor against a vacuous pass — this is the regression's own field.
    expect(rustFields).toContain("weight");

    const tsFields = tsInterfaceProps(ts, "MemoryEdge");
    expect(rustFields.filter((f) => !tsFields.includes(f))).toEqual([]);
  });
});

const snakeToCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Tauri-visible argument names of `pub (async) fn <name>(...)`, as the
 *  frontend must spell them: injected `State`/`AppHandle`/`Window` parameters
 *  dropped, snake_case turned camelCase (Tauri's default for command args). */
function rustCommandArgKeys(source: string, name: string): string[] {
  const m = new RegExp(`pub (?:async )?fn ${name}\\s*\\(([\\s\\S]*?)\\)\\s*->`).exec(source);
  if (!m) throw new Error(`Rust command ${name} not found — the source moved`);
  // Strip generics first, innermost out, so `State<'_, Arc<X>>`'s comma
  // cannot split a parameter.
  let params = m[1];
  for (let prev = ""; prev !== params;) {
    prev = params;
    params = params.replace(/<[^<>]*>/g, "");
  }
  return params
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !/:\s*(?:tauri::)?(?:State|AppHandle|Window|WebviewWindow)\s*$/.test(p))
    .map((p) => snakeToCamel(p.split(":")[0].trim()));
}

/** Top-level keys of the object literal passed to `invoke("<name>", { ... })`
 *  in `source`; `[]` when it is called with no argument object. */
function tsInvokeArgKeys(source: string, name: string): string[] {
  const m = new RegExp(`invoke(?:<[^(]*>)?\\(\\s*"${name}"\\s*(?:,\\s*\\{([^}]*)\\})?\\s*\\)`).exec(
    source,
  );
  if (!m) throw new Error(`invoke("${name}") not found — the source moved`);
  if (!m[1]) return [];
  return m[1]
    .split(",")
    .map((p) => /^\s*(\w+)/.exec(p)?.[1])
    .filter((k): k is string => !!k);
}

describe("thread history ↔ agent_host wire shapes (#7)", () => {
  const host = read("src-tauri", "src", "commands", "agent_host.rs");
  const commands = read("src-tauri", "src", "commands", "agents.rs");
  const ts = read("src", "features", "chat", "lib", "history-api.ts");

  // Rust struct → the TS interface that reads it.
  const PAIRS: Array<[rust: string, ts: string]> = [
    ["ThreadRow", "ThreadRow"],
    ["ThreadProjectWire", "ThreadProject"],
    ["ResumedThread", "ResumedThread"],
    ["ImportCandidate", "ImportCandidate"],
  ];

  for (const [rustName, tsName] of PAIRS) {
    it(`${tsName} matches Rust ${rustName} field for field`, () => {
      const { attrs, body } = rustItem(host, "struct", rustName);
      expect(attrs).toMatch(/rename_all\s*=\s*"camelCase"/);
      const rustWire = rustStructFields(body).map(snakeToCamel);
      expect(rustWire.length).toBeGreaterThan(1);
      expect([...tsInterfaceProps(ts, tsName)].sort()).toEqual([...rustWire].sort());
    });
  }

  it("ThreadRow carries liveElsewhere (floor against a vacuous pass)", () => {
    expect(tsInterfaceProps(ts, "ThreadRow")).toContain("liveElsewhere");
  });

  it("ThreadRow carries settledAt, the Settled shelf's only input", () => {
    expect(tsInterfaceProps(ts, "ThreadRow")).toContain("settledAt");
  });

  it("the threads_* history commands are returned as those structs", () => {
    expect(commands).toMatch(/fn threads_history\([\s\S]*?\) -> Result<Vec<[\w:]*ThreadRow>/);
    expect(commands).toMatch(
      /fn threads_projects\([\s\S]*?\) -> Result<Vec<[\w:]*ThreadProjectWire>/,
    );
  });

  // Every `threads_*` command history-api.ts invokes, with its argument keys.
  const invoked = [...ts.matchAll(/invoke(?:<[^(]*>)?\(\s*"(threads_\w+)"/g)].map((m) => m[1]);

  it("covers the thread commands, including threads_sync_project", () => {
    expect(invoked).toEqual(
      expect.arrayContaining([
        "threads_sync_project",
        "threads_projects",
        "threads_history",
        "threads_settle",
        "threads_unsettle",
      ]),
    );
  });

  for (const name of invoked) {
    it(`${name}'s argument keys match its Rust parameters`, () => {
      expect([...tsInvokeArgKeys(ts, name)].sort()).toEqual(
        [...rustCommandArgKeys(commands, name)].sort(),
      );
    });
  }

  it("threads_sync_project takes `cwd` on both sides", () => {
    expect(rustCommandArgKeys(commands, "threads_sync_project")).toEqual(["cwd"]);
    expect(tsInvokeArgKeys(ts, "threads_sync_project")).toEqual(["cwd"]);
  });
});

describe("comms_start_call names its provider; comms_features ↔ ChatFeatures (#5)", () => {
  const command = read("src-tauri", "src", "commands", "comms.rs");
  const rest = read("crates", "atlas-comms", "src", "rest.rs");
  const api = read("src", "features", "comms", "lib", "comms-api.ts");
  const types = read("src", "features", "comms", "types.ts");

  it("the Rust command takes `provider`, and the wrapper sends it", () => {
    // The regression: the start carried no provider, the server defaulted it
    // to a paid Meeting, and an Organisation without Meetings could start no
    // call from the desktop at all — not even the free Voice Call.
    expect(command).toMatch(/pub async fn comms_start_call\([^)]*provider: Option<String>/);
    expect(api).toMatch(/invoke<ChatCall>\("comms_start_call",\s*\{[^}]*\bprovider\b[^}]*\}\)/);
  });

  it("every ChatFeatures field is on the frontend's ChatFeatures", () => {
    const rustFields = rustStructFields(rustItem(rest, "struct", "ChatFeatures").body);
    expect(rustFields).toEqual(["features", "mesh_call_max"]);
    const tsFields = tsInterfaceProps(types, "ChatFeatures");
    expect(rustFields.filter((f) => !tsFields.includes(f))).toEqual([]);
  });
});

describe("chat Message ↔ ChatMessage, and who wrote it (#6)", () => {
  // The regression: the server marks a message an incoming webhook posted
  // (`author_kind: "webhook"`, `author_name`, …) and neither the Rust wire
  // types nor the frontend's knew the fields, so serde dropped them and the
  // transcript looked the webhook's `whk_…` id up as a member: "Unknown".
  const wire = read("crates", "atlas-comms", "src", "wire.rs");
  const events = read("crates", "atlas-comms", "src", "events.rs");
  const types = read("src", "features", "comms", "types.ts");
  const AUTHOR_FIELDS = ["author_kind", "author_name", "author_via", "author_avatar_hash"];

  it("every wire Message field reaches the renderer's WireMessage and ChatMessage", () => {
    const message = rustStructFields(rustItem(wire, "struct", "Message").body);
    const messageNew = rustStructFields(rustItem(wire, "struct", "MessageNew").body);
    const renderer = rustStructFields(rustItem(events, "struct", "WireMessage").body);
    for (const field of AUTHOR_FIELDS) {
      expect(message).toContain(field);
      expect(messageNew).toContain(field);
    }
    expect(message.filter((f) => !renderer.includes(f))).toEqual([]);
    const ts = tsInterfaceProps(types, "ChatMessage");
    expect(message.filter((f) => !ts.includes(f))).toEqual([]);
  });

  it("every Rust AuthorKind is a ChatAuthorKind", () => {
    const variants = rustEnumVariants(rustItem(wire, "enum", "AuthorKind").body).map(pascalToSnake);
    expect(variants).toEqual(["user", "webhook"]);
    const ts = tsUnionLiterals(types, "ChatAuthorKind");
    expect(variants.filter((v) => !ts.includes(v))).toEqual([]);
    // The catch-all serialises as `other`; the renderer has to accept it.
    expect(ts).toContain("other");
  });
});

describe("subagents: Rust Subagent ↔ the renderer's Subagent (#8)", () => {
  // ACP has no subagent concept, so a subagent is read out of an ordinary
  // tool call (`atlas_acp_thread::subagent`) and projected onto the delta
  // wire. Two shapes have to agree, and they disagree in different cases:
  //
  //  - `Subagent` is `rename_all = "camelCase"`, so its Rust field names
  //    reach the renderer camelCased.
  //  - the wire `ToolCall` has NO rename, so its new `parent_tool_call_id`
  //    arrives snake_cased and the renderer's own camelCase `ToolCall` only
  //    gets it because `toChatToolCall` maps it across.
  //
  // Both are the silent-undefined failure this file exists for: the renderer
  // would group every child under "no parent" and show nothing.
  const types = read("crates", "atlas-agent-wire", "src", "types.rs");
  const delta = read("crates", "atlas-agent-wire", "src", "delta.rs");
  const wireTs = read("src", "types", "agents.ts");
  const agentTs = read("src", "types", "agent.ts");
  const store = read("src", "features", "chat", "stores", "chat-store.ts");

  it("every Rust Subagent field is on the renderer's Subagent, camelCased", () => {
    const rustFields = rustStructFields(rustItem(types, "struct", "Subagent").body);
    expect(rustFields).toContain("tool_call_id");
    expect(rustFields).toContain("status");
    const ts = tsInterfaceProps(agentTs, "Subagent");
    const missing = rustFields
      .map((field) => field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()))
      .filter((field) => !ts.includes(field));
    expect(missing).toEqual([]);
  });

  it("every Rust SubagentStatus is a renderer SubagentStatus", () => {
    const variants = rustEnumVariants(rustItem(types, "enum", "SubagentStatus").body).map(
      pascalToSnake,
    );
    expect(variants).toEqual(["running", "completed", "failed", "interrupted"]);
    const ts = tsUnionLiterals(agentTs, "SubagentStatus");
    expect(variants.filter((v) => !ts.includes(v))).toEqual([]);
  });

  it("the subagent_upserted delta exists on both sides", () => {
    expect(delta).toMatch(/SubagentUpserted\s*\{\s*subagent: Subagent,/);
    expect(wireTs).toMatch(/kind: "subagent_upserted";/);
  });

  it("a tool call's parent link survives the wire's snake_case", () => {
    expect(rustStructFields(rustItem(types, "struct", "ToolCall").body)).toContain(
      "parent_tool_call_id",
    );
    // The wire-shaped TS declares what Rust actually sends …
    expect(tsInterfaceProps(wireTs, "ToolCall")).toContain("parent_tool_call_id");
    // … and the mapper is what turns it into the renderer's camelCase field.
    expect(tsInterfaceProps(agentTs, "ToolCallDisplay")).toContain("parentToolCallId");
    expect(store).toMatch(/parentToolCallId:\s*tc\.parent_tool_call_id/);
  });
});

describe("slept_mid_turn: Rust SleptMidTurn ↔ the renderer's delta (#9)", () => {
  // The host names a turn the computer slept through (`sleep_watch.rs`). Both
  // fields are read by the chat store — `turn_seq` is its stale guard — so a
  // rename on either side compiles and the notice silently attaches to
  // nothing (or to a superseded turn).
  const delta = read("crates", "atlas-agent-wire", "src", "delta.rs");
  const wireTs = read("src", "types", "agents.ts");
  const store = read("src", "features", "chat", "stores", "chat-store.ts");

  it("the variant carries the same fields on both sides", () => {
    expect(delta).toMatch(/SleptMidTurn\s*\{\s*turn_seq: u64,\s*slept_secs: u64,\s*\}/);
    const ts = /kind: "slept_mid_turn";([\s\S]*?)\}/.exec(wireTs);
    expect(ts, "the slept_mid_turn member of AgentDelta").not.toBeNull();
    expect(ts![1]).toMatch(/\bturn_seq: number;/);
    expect(ts![1]).toMatch(/\bslept_secs: number;/);
  });

  it("the chat store applies it", () => {
    expect(store).toMatch(/case "slept_mid_turn":/);
    expect(store).toMatch(/env\.turn_seq/);
  });
});

describe("timing: tool-call and turn times ↔ the renderer (#10)", () => {
  // A call's start/end and a turn's wall time travel from Rust so "Worked for",
  // "Stopped after" and each step's duration survive a reload. Every name here
  // is a string to `tsc`: a rename on either side compiles, and the durations
  // silently vanish from every reloaded session.
  const types = read("crates", "atlas-agent-wire", "src", "types.rs");
  const delta = read("crates", "atlas-agent-wire", "src", "delta.rs");
  const wireTs = read("src", "types", "agents.ts");
  const store = read("src", "features", "chat", "stores", "chat-store.ts");
  const snapshot = read("src", "features", "chat", "lib", "snapshot-message.ts");

  it("a tool call's times are declared on both sides and mapped by the store", () => {
    const rust = rustStructFields(rustItem(types, "struct", "ToolCall").body);
    const ts = tsInterfaceProps(wireTs, "ToolCall");
    for (const field of ["started_at_ms", "ended_at_ms"]) {
      expect(rust).toContain(field);
      expect(ts).toContain(field);
      expect(store).toContain(`tc.${field}`);
      expect(snapshot).toContain(`tc.${field}`);
    }
  });

  it("a snapshot message carries its turn's timing on both sides", () => {
    const rust = rustStructFields(rustItem(types, "struct", "Message").body);
    const ts = tsInterfaceProps(wireTs, "SessionMessage");
    for (const field of ["worked_ms", "stop_reason"]) {
      expect(rust).toContain(field);
      expect(ts).toContain(field);
      expect(snapshot).toContain(`m.${field}`);
    }
  });

  it("turn_finished carries the turn's start and end on both sides", () => {
    const rust = /TurnFinished\s*\{([\s\S]*?)\n\s{4}\},/.exec(delta);
    expect(rust, "the TurnFinished variant").not.toBeNull();
    const ts = /kind: "turn_finished";([\s\S]*?)\}/.exec(wireTs);
    expect(ts, "the turn_finished member of AgentDelta").not.toBeNull();
    for (const field of ["started_at_ms", "worked_ms"]) {
      expect(rust![1]).toMatch(new RegExp(`\\b${field}: Option<(i64|u64)>,`));
      expect(ts![1]).toMatch(new RegExp(`\\b${field}\\?: number;`));
      expect(store).toContain(`env.${field}`);
    }
    expect(rust![1]).toMatch(/\bended_at_ms: Option<i64>,/);
    expect(ts![1]).toMatch(/\bended_at_ms\?: number;/);
  });
});

/** Field names of one `Variant { ... }` inside an enum body. */
function rustVariantFields(enumBody: string, variant: string): string[] {
  const m = new RegExp(`\\n\\s{4}${variant}\\s*\\{([\\s\\S]*?)\\n\\s{4}\\},`).exec(enumBody);
  if (!m) throw new Error(`Rust variant ${variant} not found — the source moved`);
  return rustStructFields(m[1]);
}

describe("cloud comments: TS Comment ↔ atlas_artifacts Comment (#11)", () => {
  const rust = read("crates", "atlas-artifacts", "src", "model.rs");
  const ts = read("src", "features", "artifacts", "lib", "comments-api.ts");

  it("Comment has the same fields on both sides, camelCased", () => {
    const { attrs, body } = rustItem(rust, "struct", "Comment");
    expect(attrs).toMatch(/rename_all\s*=\s*"camelCase"/);
    const rustFields = rustStructFields(body).map(snakeToCamel).sort();
    // Floor against a vacuous pass: the fields the passage comment relies on.
    expect(rustFields).toEqual(expect.arrayContaining(["anchorKind", "anchorId", "body"]));
    expect(tsInterfaceProps(ts, "Comment").sort()).toEqual(rustFields);
  });

  it("CommentVotes has the same fields on both sides", () => {
    const { body } = rustItem(rust, "struct", "CommentVotes");
    expect(tsInterfaceProps(ts, "CommentVotes").sort()).toEqual(rustStructFields(body).sort());
  });

  it("AnchorKind has the same members on both sides", () => {
    const { attrs, body } = rustItem(rust, "enum", "AnchorKind");
    expect(attrs).toMatch(/rename_all\s*=\s*"snake_case"/);
    expect(tsUnionLiterals(ts, "AnchorKind").sort()).toEqual(
      rustEnumVariants(body).map(pascalToSnake).sort(),
    );
  });
});

describe("cite chip: MentionCitedText ↔ MentionSpec::CitedText (#12)", () => {
  const rust = read("src-tauri", "src", "commands", "compose_prompt.rs");
  const ts = read("src", "features", "chat", "lib", "mentions.ts");

  it("carries the same fields under the same tag", () => {
    const { attrs, body } = rustItem(rust, "enum", "MentionSpec");
    expect(attrs).toMatch(/tag\s*=\s*"kind"/);
    expect(attrs).toMatch(/rename_all\s*=\s*"snake_case"/);
    expect(attrs).toMatch(/rename_all_fields\s*=\s*"camelCase"/);
    const rustFields = rustVariantFields(body, "CitedText").map(snakeToCamel).sort();
    expect(rustFields).toEqual(expect.arrayContaining(["messageId", "rowId", "text", "note"]));
    const tsFields = tsInterfaceProps(ts, "MentionCitedText").filter((f) => f !== "kind");
    expect(tsFields.sort()).toEqual(rustFields);
    expect(ts).toMatch(/interface MentionCitedText \{\s*kind: "cited_text";/);
    expect(pascalToSnake("CitedText")).toBe("cited_text");
  });
});

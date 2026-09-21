import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Four small, independent wire-shape regressions, each found by hand while
 * auditing the app for pre-existing bugs (none is about the theme system):
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
 * Unlike `tests/state-payload-contract.test.ts` (which is specifically the
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

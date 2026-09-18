import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the Tauri *event* seam, the way `ipc-contract.test.ts` guards the
 * command seam: every `listen("atlas:…")` on the TypeScript side must have a
 * producer — an `"atlas:…"` literal on the Rust side (emit sites and the
 * consts they read from) or a TS-side `emit("atlas:…")`.
 *
 * Nothing else in the toolchain can see this seam either. Event names are
 * opaque strings to both compilers, so deleting a Rust module that owned an
 * emitter leaves its TS listeners compiling clean and waiting forever — the
 * feature quietly stops updating. That exact class of break was possible
 * during the 2026-08-22 module removals (memory-chat's model events died with
 * `memory_chat.rs`); this test makes the next one loud.
 *
 * Window `CustomEvent`s (`dispatchEvent`/`addEventListener`) are TS↔TS and
 * type-checked routes exist for neither side, but they never cross the IPC
 * boundary — they are out of scope here on purpose.
 *
 * Only *shipping* code counts on either side. `src/dev/` (the browser mock
 * backend, which emits most channels itself so `bun run dev` has data) and
 * test files are excluded from both scans: a mock `emit("atlas:agents")`
 * must not stand in for the Rust emitter it imitates, or Rust could stop
 * emitting and this suite would stay green.
 *
 * Listens that name the channel through an exported string constant
 * (`listen(THREADS_CHANGED_EVENT, …)`) are resolved through every
 * `export const X = "atlas:…"` in shipping code, so they are checked too.
 *
 * If you add an event, nothing here needs updating — the sets are derived.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TS_SRC = path.join(REPO_ROOT, "src");
const RUST_ROOTS = [path.join(REPO_ROOT, "src-tauri", "src"), path.join(REPO_ROOT, "crates")];

/**
 * Floors that make a vacuous pass impossible: if a refactor breaks the
 * extraction regexes, the derived sets collapse and the subset assertion
 * passes trivially. These are well under the real counts at the time of
 * writing (32 listened / 58+ produced) — a smoke alarm for "the parser
 * broke", not a coverage target.
 */
const MIN_LISTENED = 15;
const MIN_PRODUCED = 30;

function walk(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, extensions));
    else if (extensions.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/** The mock backend under `src/dev/` and test files are not shipping code:
 *  neither may produce, nor count as listening to, a real channel. */
const TS_DEV_DIR = path.join(TS_SRC, "dev") + path.sep;
function isShippingTs(file: string): boolean {
  if (file.startsWith(TS_DEV_DIR)) return false;
  return !/\.(?:test|spec)\.tsx?$/.test(file) && !file.includes(`${path.sep}__tests__${path.sep}`);
}

function shippingTsFiles(): string[] {
  return walk(TS_SRC, [".ts", ".tsx"]).filter(isShippingTs);
}

/** `export const X = "atlas:…"` across shipping TS, so a listen that names
 *  its channel through a constant resolves to the literal. */
function eventConstants(): Map<string, string> {
  const out = new Map<string, string>();
  const decl = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*"(atlas:[a-z0-9:_-]+)"/g;
  for (const file of shippingTsFiles()) {
    for (const m of readFileSync(file, "utf8").matchAll(decl)) out.set(m[1], m[2]);
  }
  return out;
}

/** Events the frontend subscribes to via Tauri `listen`/`once`. The name may
 *  sit a line or two after the call (formatting), so the window after the
 *  call site is searched rather than demanding one exact shape. */
function listenedEvents(constants: Map<string, string>): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const call = /\b(?:listen|once)\s*(?:<[^;]*?>)?\s*\(/g;
  // First argument given as a bare identifier: `listen(THREADS_CHANGED_EVENT, …)`.
  const identArg = /^\s*([A-Za-z_$][\w$]*)\s*[,)]/;
  for (const file of shippingTsFiles()) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(call)) {
      const after = src.slice(m.index + m[0].length);
      const ident = after.match(identArg);
      const window = src.slice(m.index, m.index + 200);
      const name =
        (ident && constants.get(ident[1])) ?? window.match(/"(atlas:[a-z0-9:_-]+)"/)?.[1];
      if (!name) continue;
      const where = path.relative(REPO_ROOT, file);
      found.set(name, [...(found.get(name) ?? []), where]);
    }
  }
  return found;
}

/** Every `"atlas:…"` literal a producer could emit under: all Rust literals
 *  (emit sites + the consts they're built from) plus Tauri emits from
 *  shipping TS — never the mock backend's. */
function producedEvents(): Set<string> {
  const out = new Set<string>();
  const literal = /"(atlas:[a-z0-9:_-]+)"/g;
  for (const root of RUST_ROOTS) {
    for (const file of walk(root, [".rs"])) {
      for (const m of readFileSync(file, "utf8").matchAll(literal)) out.add(m[1]);
    }
  }
  const emitCall = /\bemit\s*\(\s*"(atlas:[a-z0-9:_-]+)"/g;
  for (const file of shippingTsFiles()) {
    for (const m of readFileSync(file, "utf8").matchAll(emitCall)) out.add(m[1]);
  }
  return out;
}

describe("tauri event contract", () => {
  const constants = eventConstants();
  const listened = listenedEvents(constants);
  const produced = producedEvents();

  it("extracted enough of both sides to be meaningful", () => {
    expect(listened.size).toBeGreaterThanOrEqual(MIN_LISTENED);
    expect(produced.size).toBeGreaterThanOrEqual(MIN_PRODUCED);
  });

  it("resolves listens that name their channel through an exported constant", () => {
    // Spot-check: each of these is only ever listened to via a constant, so
    // if constant resolution broke they would silently drop out of the check.
    for (const name of [
      "atlas:threads-changed",
      "atlas:themes-changed",
      "atlas:icon-themes-changed",
    ]) {
      expect(listened.has(name), `${name} not seen as listened`).toBe(true);
    }
  });

  it("does not count the mock backend or tests as a producer or a listener", () => {
    const leaked = [...listened.values()]
      .flat()
      .filter((f) => f.startsWith(`src${path.sep}dev${path.sep}`) || /\.test\.tsx?$/.test(f));
    expect(leaked).toEqual([]);
  });

  it("every listened event has a producer", () => {
    const orphans = [...listened.entries()]
      .filter(([name]) => {
        if (produced.has(name)) return false;
        // Prefixed families: Rust builds names like `atlas:model-download:progress`
        // from a base + suffix in `format!`; a literal prefix match covers them.
        return ![...produced].some((p) => name.startsWith(`${p}:`) || p.startsWith(`${name}:`));
      })
      .map(([name, files]) => `${name} (listened in ${files.join(", ")})`);
    expect(orphans).toEqual([]);
  });
});

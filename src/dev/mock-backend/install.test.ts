// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

/**
 * `install.ts` installs `mockIPC` synchronously but loads every fixture behind
 * a dynamic `import()`, so `bun run dev:app` never evaluates them. That split
 * only works if the app can call `invoke()` and `listen()` during the gap —
 * `main.tsx` runs as soon as `install.ts` returns, long before the fixtures
 * arrive. These pin the gap down: nothing sent early is lost or answered
 * wrong.
 */
describe("mock backend install", () => {
  it("answers a command sent before the fixtures have loaded", async () => {
    const { installMockBackend } = await import("./install");
    // Importing the module already started one install (it is the injected
    // entry); a second one races it the same way, from a known instant.
    const ready = installMockBackend("default");
    const early = invoke<string>("git_graph_signature", { path: "/x" });
    const seenEarly: unknown[] = [];
    await listen("mock-install-test", (e) => seenEarly.push(e.payload));
    await ready;
    await expect(early).resolves.toMatch(/:/);
    await emit("mock-install-test", 1);
    expect(seenEarly).toEqual([1]);
    expect(window.__atlasMock?.scenario).toBe("default");
  });

  it("still answers an unmocked command with null", async () => {
    await import("./install");
    // Built, not written: `tests/ipc-contract.test.ts` rejects a literal
    // `invoke("…")` that names no Rust command.
    const unknown = ["no", "such", "command"].join("_");
    await expect(invoke(unknown)).resolves.toBeNull();
  });
});

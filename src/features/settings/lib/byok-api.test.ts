import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reference pattern for testing an IPC seam module.
 *
 * `invoke` is mocked, so these tests assert the *wire contract*: which command
 * a call targets and the exact payload shape Rust will deserialise. They do
 * not prove the command exists — `tests/ipc-contract.test.ts` does that for
 * every command in the app at once. Together the two cover the seam without
 * either needing a running Tauri process.
 *
 * Since 2026-08-22 this seam edits the user's shell profile instead of a
 * private key store, so the argument names below (`envVar`, `value`) are what
 * `byok_env_set` / `byok_env_unset` destructure — a rename on either side is a
 * silent no-op at runtime, which is exactly what these catch.
 */
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { byok } = await import("./byok-api");

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("byok.envList", () => {
  it("calls byok_env_list with no payload", async () => {
    invoke.mockResolvedValue([]);
    await byok.envList();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_env_list");
  });
});

describe("byok.entries", () => {
  it("calls byok_env_entries with no payload", async () => {
    invoke.mockResolvedValue([]);
    await byok.entries();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_env_entries");
  });
});

describe("byok.profileInfo", () => {
  it("calls byok_profile_info with no payload", async () => {
    invoke.mockResolvedValue({ shell: "/bin/zsh", target: "/Users/a/.zshrc", scanned: [] });
    await byok.profileInfo();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_profile_info");
  });
});

describe("byok.reveal", () => {
  it("sends the variable name under `envVar`", async () => {
    invoke.mockResolvedValue("sk-secret");
    await byok.reveal("ANTHROPIC_API_KEY");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_env_reveal", {
      envVar: "ANTHROPIC_API_KEY",
    });
  });
});

describe("byok.set", () => {
  it("sends the variable and the raw value", async () => {
    invoke.mockResolvedValue("/Users/a/.zshrc");
    await byok.set("ANTHROPIC_API_KEY", "sk-ant-abcd1234");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_env_set", {
      envVar: "ANTHROPIC_API_KEY",
      value: "sk-ant-abcd1234",
    });
  });

  it("does NOT derive metadata — Rust owns what lands in the file", async () => {
    // The old store took `last4`/`addedAt` from here. The profile editor writes
    // one `export` line and nothing else, so sending extras would be a lie.
    invoke.mockResolvedValue("/Users/a/.zshrc");
    await byok.set("OPENAI_API_KEY", "sk-openai-wxyz9876");
    expect(Object.keys(invoke.mock.calls[0][1])).toEqual(["envVar", "value"]);
  });
});

describe("byok.unset", () => {
  it("calls byok_env_unset with just the variable", async () => {
    await byok.unset("ANTHROPIC_API_KEY");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("byok_env_unset", {
      envVar: "ANTHROPIC_API_KEY",
    });
  });
});

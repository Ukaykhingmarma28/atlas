// The session context overlay's own commands: where the session runs
// (`commands/session_context.rs`) and the project's scripts
// (`commands/project_scripts.rs`). Everything else the overlay shows comes
// from the features that own it (git, pull requests, external editor).

import { invoke } from "@tauri-apps/api/core";

/** The machine a session runs on. */
export interface SessionEnvironment {
  /** The short host name (`m4-pro`); empty when the system would not say. */
  name: string;
  /** `local` today: every Atlas session runs on this machine. */
  kind: string;
}

export function sessionEnvironment(): Promise<SessionEnvironment> {
  return invoke<SessionEnvironment>("session_environment");
}

/** The glyph a project script carries. */
export type ProjectScriptIcon = "play" | "test" | "lint" | "configure" | "build" | "debug";

/** A named command a project keeps, run in a terminal at the project root.
 *  Stored as `[[scripts]]` in `<project>/.atlas/config.toml`. */
export interface ProjectScript {
  /** Stable within the project; Rust derives it from the name when blank. */
  id: string;
  name: string;
  command: string;
  icon: ProjectScriptIcon;
}

export function listProjectScripts(projectPath: string): Promise<ProjectScript[]> {
  return invoke<ProjectScript[]>("project_scripts_list", { projectPath });
}

/** Replace the project's scripts; answers what was written (trimmed, ids
 *  made unique). */
export function saveProjectScripts(
  projectPath: string,
  scripts: ProjectScript[],
): Promise<ProjectScript[]> {
  return invoke<ProjectScript[]>("project_scripts_save", { projectPath, scripts });
}

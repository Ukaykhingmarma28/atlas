// Project scripts: which one the row runs, what id a new one gets, and how
// one is run — typed into a terminal tab at the project root.
//
// The terminal is the user's own interactive shell (`openCommandTerminal`),
// not a spawned pipe: a dev server keeps running where it can be watched and
// stopped, and a script that asks a question can be answered.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { openCommandTerminal, shellQuote } from "@/features/terminal/lib/open-command-terminal";

import { listProjectScripts, saveProjectScripts, type ProjectScript } from "./session-context-api";

const MAX_SCRIPT_ID_LENGTH = 64;

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "script";
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) return cleaned;
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

/** A fresh id for a script called `name`: its slug, numbered past any taken. */
export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;
    const safe =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safe)) return safe;
  }
  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

/** The script the row's main button runs: the one last run, else the first. */
export function primaryProjectScript(
  scripts: readonly ProjectScript[],
  preferredId: string | null = null,
): ProjectScript | null {
  return (
    (preferredId ? scripts.find((s) => s.id === preferredId) : undefined) ?? scripts[0] ?? null
  );
}

/**
 * The line typed into the shell: change to the project root, then run. The
 * leading space keeps it out of shell history where the shell honours that
 * (bash `ignorespace`, zsh `HIST_IGNORE_SPACE`, fish).
 */
export function projectScriptTerminalLine(projectPath: string, command: string): string {
  return ` cd ${shellQuote(projectPath)} && ${command}`;
}

/** The script last run per project, so the row offers it next. */
const lastRun = new Map<string, string>();

export function preferredProjectScriptId(projectPath: string): string | null {
  return lastRun.get(projectPath) ?? null;
}

/** Run `script` in a new terminal tab at the project root. */
export function runProjectScript(projectPath: string, script: ProjectScript): void {
  lastRun.set(projectPath, script.id);
  const opened = openCommandTerminal(
    projectScriptTerminalLine(projectPath, script.command),
    script.name,
  );
  if (!opened) toast.error(`Could not open a terminal for ${script.name}`);
}

export const projectScriptsKey = (projectPath: string) =>
  ["session-context", "project-scripts", projectPath] as const;

/** The project's scripts, read from its `.atlas/config.toml`. */
export function useProjectScripts(projectPath: string | null) {
  return useQuery({
    queryKey: projectScriptsKey(projectPath ?? ""),
    queryFn: () => listProjectScripts(projectPath!),
    enabled: !!projectPath,
    staleTime: 30_000,
  });
}

/** Replace a project's scripts and refresh every reader of them. */
export function useSaveProjectScripts() {
  const client = useQueryClient();
  return async (projectPath: string, scripts: ProjectScript[]): Promise<ProjectScript[]> => {
    const saved = await saveProjectScripts(projectPath, scripts);
    client.setQueryData(projectScriptsKey(projectPath), saved);
    return saved;
  };
}

import type { ChatMessage } from "@/types/agent";
import { getEditParts, getFilePathFromInput } from "./tool-files";
import { toRepoRelative } from "./open-turn-diff";

/** The before/after text for one file, as a turn left it. */
export interface TurnEdit {
  old: string;
  new: string;
}

export interface TurnEdits {
  /** Files the turn changed, in the order it first touched them. */
  files: string[];
  /** Which file the viewer should land on. */
  initial: string;
  sources: Record<string, TurnEdit>;
  /**
   * Files whose pair is only the text the agent replaced, never the whole
   * file: an `Edit` names a fragment. Their diff is an excerpt, its line
   * numbers count from the fragment, and the viewer says so.
   */
  excerpts: ReadonlySet<string>;
}

/**
 * The before/after text a single turn produced, per file.
 *
 * Walks the turn's assistant run — `turnId` is `t:<first assistant message id>`,
 * the same formula the row projection uses — and folds every edit a tool call
 * reported into one before/after pair per path, so a turn that touched a file
 * three times reads as one diff rather than three competing ones.
 *
 * # Two shapes of edit, folded differently
 *
 * An edit reaches Atlas either as recognisable tool ARGUMENTS or as an ACP
 * `diff` CONTENT BLOCK, and the two carry different things:
 *
 * - **Arguments** carry a fragment. An `Edit` names the text it replaced, so
 *   successive edits CONCATENATE — the pair covers every fragment the turn
 *   touched, which is honest about what the record holds. (A `Write` carries
 *   whole content with an empty `old`, which is why a file the turn created
 *   renders in full.)
 * - **Diff blocks** carry the WHOLE FILE, before and after (`acp::Diff`). Concatenating those produces nonsense: two edits to one
 *   file would give `old = v0 + v1` against `new = v1 + v2`. They fold by
 *   taking the FIRST block's before and the LAST block's after — the state the
 *   turn found the file in, and the state it left it in.
 *
 * A path reported both ways takes the whole-file answer: it is the complete
 * file, and a fragment pair cannot improve on it.
 *
 * A file the turn only deleted contributes no edit at all and simply does not
 * appear, which is the correct answer — there is nothing to browse.
 */
export function collectTurnEdits(
  messages: ChatMessage[],
  turnId: string,
  repoPath: string,
  preferredFile?: string,
): TurnEdits {
  const firstId = turnId.startsWith("t:") ? turnId.slice(2) : turnId;
  const start = messages.findIndex((m) => m.id === firstId);
  /** Fragment pairs, accumulated from tool arguments. */
  const fragments: Record<string, TurnEdit> = {};
  /** Whole-file pairs, from diff blocks: first `old` wins, last `new` wins. */
  const whole: Record<string, TurnEdit> = {};
  const order: string[] = [];
  /** Paths with at least one fragment among their argument edits. */
  const fragmentary = new Set<string>();

  const see = (path: string) => {
    if (!order.includes(path)) order.push(path);
  };

  if (start >= 0) {
    // The turn is the consecutive assistant run beginning at that message.
    for (let i = start; i < messages.length && messages[i].role === "assistant"; i++) {
      for (const tc of messages[i].toolCalls) {
        // P1.4: an ACP agent may report its edit as a `diff` content block
        // instead of as recognisable Write/Edit arguments. Those carry the
        // before/after text outright, so they fold in the same way — and this
        // is the ONLY record of an edit that is not on disk yet (plan mode,
        // preview), where a git-backed diff has nothing to compare against.
        for (const block of tc.contentBlocks ?? []) {
          if (block.type !== "diff") continue;
          const path = toRepoRelative(block.path, repoPath);
          see(path);
          const seen = whole[path];
          whole[path] = { old: seen ? seen.old : (block.oldText ?? ""), new: block.newText };
        }
        const args = tc.arguments ?? {};
        const parts = getEditParts(tc.toolName, args);
        if (parts.length === 0) continue;
        const abs = getFilePathFromInput(args);
        if (!abs) continue;
        const path = toRepoRelative(abs, repoPath);
        see(path);
        const acc = (fragments[path] ??= { old: "", new: "" });
        for (const p of parts) {
          acc.old += p.old;
          acc.new += p.neu;
          // A part that replaced text is a fragment; one with nothing before
          // it is a whole file written out.
          if (p.old !== "") fragmentary.add(path);
        }
      }
    }
  }

  const sources: Record<string, TurnEdit> = {};
  const excerpts = new Set<string>();
  for (const path of order) {
    sources[path] = whole[path] ?? fragments[path];
    if (!whole[path] && fragmentary.has(path)) excerpts.add(path);
  }

  const wanted = preferredFile ? toRepoRelative(preferredFile, repoPath) : "";
  return {
    files: order,
    initial: wanted && sources[wanted] ? wanted : (order[0] ?? ""),
    sources,
    excerpts,
  };
}

/** One turn of a session that changed files, as the turn picker lists it. */
export interface EditTurn {
  /** `t:<first assistant message id>`, the transcript's turn id. */
  turnId: string;
  /** 1-based, counting every turn of the session, so a number stays put
   *  when an earlier turn changed nothing. */
  number: number;
  /** When the turn's last message arrived: when it finished, once it has. */
  timestamp: string;
  /** The prompt the turn answered, on one line; empty when there was none. */
  prompt: string;
  /** How many files it changed. */
  fileCount: number;
}

/** A prompt's snippet runs to this many characters before an ellipsis. */
export const PROMPT_SNIPPET_CHARS = 60;

/** The prompt's prose (without its @-mention context), on one line. */
function snippetOf(message: ChatMessage | undefined): string {
  if (!message || message.role !== "user") return "";
  const prose = (message.atlasProse ?? message.content).replace(/\s+/g, " ").trim();
  return prose.length > PROMPT_SNIPPET_CHARS
    ? `${prose.slice(0, PROMPT_SNIPPET_CHARS - 1).trimEnd()}…`
    : prose;
}

/** The paths one tool call edits, by either shape `collectTurnEdits` reads. */
function editedPathsOf(tc: ChatMessage["toolCalls"][number], repoPath: string): string[] {
  const paths: string[] = [];
  for (const block of tc.contentBlocks ?? []) {
    if (block.type === "diff") paths.push(toRepoRelative(block.path, repoPath));
  }
  const args = tc.arguments ?? {};
  if (getEditParts(tc.toolName, args).length > 0) {
    const abs = getFilePathFromInput(args);
    if (abs) paths.push(toRepoRelative(abs, repoPath));
  }
  return paths;
}

/**
 * Every turn of the session that changed a file, newest first.
 *
 * A turn is the run of assistant messages that answers a prompt, the same
 * run `collectTurnEdits` walks, so a listed turn always has edits to show.
 * Only paths are collected here; the texts are `collectTurnEdits`' job, for
 * the one turn the reader picks.
 */
export function listEditTurns(messages: ChatMessage[], repoPath: string): EditTurn[] {
  const out: EditTurn[] = [];
  let number = 0;
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role !== "assistant") {
      i++;
      continue;
    }
    const start = i;
    number += 1;
    const paths = new Set<string>();
    for (; i < messages.length && messages[i].role === "assistant"; i++) {
      for (const tc of messages[i].toolCalls) {
        for (const path of editedPathsOf(tc, repoPath)) paths.add(path);
      }
    }
    if (paths.size === 0) continue;
    out.push({
      turnId: `t:${messages[start].id}`,
      number,
      timestamp: messages[i - 1].timestamp,
      prompt: snippetOf(messages[start - 1]),
      fileCount: paths.size,
    });
  }
  return out.reverse();
}

/**
 * A cheap key that changes whenever a session's edits might have: a message
 * arrived, or the last one's tool calls changed in number or state. Streamed
 * prose leaves it alone, so a view keyed on it does not re-render per chunk.
 */
export function editsSignature(messages: readonly ChatMessage[] | undefined): string {
  if (!messages || messages.length === 0) return "";
  const last = messages[messages.length - 1];
  let calls = "";
  for (const tc of last.toolCalls) calls += `${tc.status[0]}${tc.contentBlocks?.length ?? 0}`;
  return `${messages.length}:${last.id}:${calls}`;
}

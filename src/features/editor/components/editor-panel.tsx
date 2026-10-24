import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Code2, Eye, RefreshCw, Table2, WrapText } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "../stores/editor-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { logEvent } from "@/features/log/lib/log";
import { gitDiffLineStatus } from "@/features/git/lib/git-diff-api";
import { gitBlameFile } from "@/features/git/lib/git-blame-api";
import { MarkdownFile } from "@/lib/markdown-fileviewer";
import { openFileAs } from "@/lib/open-file";
import { Button } from "@/ui/button";
import { useProjectSetting } from "@/features/settings/lib/use-scoped-setting";
import { useWordWrap } from "@/features/settings/lib/use-word-wrap";
import { OpenInEditorButton } from "@/features/external-editor/components/open-in-editor-button";
import { FileIcon } from "@/features/icon-theme/components/file-icon";
import { useScopedHotkeys } from "@/features/keybindings/lib/use-scoped-hotkeys";
import { useFileTabFrame } from "@/features/explorer/lib/file-tab-frame-context";
import { openInProject } from "@/features/explorer/lib/open-in-project";
import { revealFiles } from "@/features/layout/lib/files-surface";
import { BLAME_PART_COLOR } from "../lib/blame";
import { registerEditorView } from "../lib/editor-views";
import { FileDecorations } from "../lib/file-decorations";
import { filePreviewDelimiter } from "../lib/delimited-preview";
import { retainedBreadcrumbTrail } from "../lib/file-path";
import {
  readRenderedPreference,
  renderedModeOf,
  renderedToggleLabel,
  writeRenderedPreference,
} from "../lib/file-preview-mode";
import { useFileSaveCoordinator } from "../lib/use-file-save-coordinator";
import { CodeFileView, type CodeFileViewHandle } from "./code-file-view";
import { DelimitedTablePreview } from "./delimited-table-preview";
import { FileBreadcrumbsRow, type FileBreadcrumbsProps } from "./file-breadcrumbs";
import { HtmlPreview } from "./html-preview";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "./file-surface-chrome";

/**
 * A file tab: the file's text in the code view (`code-file-view.tsx`),
 * editable in place, or — for markdown, CSV/TSV and HTML — rendered, with a
 * toggle between the two.
 *
 * This panel owns the file's I/O: reading it, saving it on ⌘S, and noticing
 * when it changed on disk. The document itself is the code view's editor's;
 * the panel asks it for the text when it needs it, and is told only when the
 * file starts or stops differing from disk, so typing never re-renders it.
 */

/** Coalescing window for watcher-driven disk reconciliation (see below). */
const REVALIDATE_DEBOUNCE_MS = 150;

/** Past this size a file opens read-only and unhighlighted: editing and
 *  tokenizing tens of megabytes of text is not what this view is for. */
export const LARGE_FILE_CHARS = 8 * 1024 * 1024;

interface EditorPanelProps {
  tabId: string;
  filePath?: string;
  containerHeight: number;
}

function relativeTo(path: string, projectPath: string): string | null {
  if (!projectPath || !path.startsWith(projectPath + "/")) return null;
  return path.slice(projectPath.length + 1);
}

export function EditorPanel({ tabId, filePath, containerHeight }: EditorPanelProps) {
  const path = filePath ?? "";
  const isUntitled = path.startsWith("untitled:");
  const buffer = useEditorStore((s) => s.buffers[path]);
  const pendingReveal = useEditorStore((s) => s.pendingReveals[path]);
  const { openBuffer, setDirty, markSaved, reloadBuffer, markExternallyChanged, consumeReveal } =
    useEditorStore.use.actions();
  const projectPath = useAppStore.use.currentProject()?.path ?? "";
  const layoutActions = useLayoutStore.use.actions();
  const viewRef = useRef<CodeFileViewHandle | null>(null);
  const [decorations] = useState(() => new FileDecorations());
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped when the document is replaced from disk; the code view takes the
  // buffer's contents as a new document only then.
  const [docVersion, setDocVersion] = useState(0);

  const relPath = relativeTo(path, projectPath);
  const { wrap: wordWrap, toggle: toggleWordWrap } = useWordWrap();

  // ── Breadcrumbs ──
  // Rooted at the tab's own project (the frame's), then the active one; a
  // file outside both is crumbed from the filesystem root.
  const frame = useFileTabFrame();
  const projectName = useAppStore.use.currentProject()?.name ?? "";
  const crumbTarget = (() => {
    if (!path || isUntitled) return null;
    const root = frame?.root ?? (relPath !== null ? projectPath : null);
    const rel = root ? relativeTo(path, root) : null;
    if (!root || rel === null) {
      return { root: null, projectName: "", trail: path, current: path };
    }
    const name = (frame?.root ? frame.projectName : null) ?? projectName;
    const folder = frame?.root === root ? frame.crumbFolder : null;
    const current = folder ?? rel;
    return {
      root,
      projectName: name || root.split("/").pop() || root,
      trail: retainedBreadcrumbTrail(rel, current),
      current,
    };
  })();
  const navigateCrumb = (crumbPath: string) => {
    if (!crumbTarget) return;
    if (crumbTarget.root === null) {
      // Outside the project there is no tree to walk: show the folder where
      // the system keeps it.
      void import("@tauri-apps/plugin-opener").then(({ revealItemInDir }) =>
        revealItemInDir(crumbPath).catch(() => {}),
      );
      return;
    }
    if (frame?.root === crumbTarget.root) {
      if (crumbPath === crumbTarget.trail) frame.revealFile();
      else frame.revealFolder(crumbPath);
      return;
    }
    revealFiles(crumbPath ? `${crumbTarget.root}/${crumbPath}` : crumbTarget.root);
  };
  const gitBlameInline = useProjectSetting(projectPath, "gitBlameInline");

  // ── Load ──
  useEffect(() => {
    if (!path || buffer) return;
    if (isUntitled) {
      openBuffer(path, "");
      return;
    }
    let live = true;
    setLoadError(null);
    void (async () => {
      try {
        const content = await invoke<string>("read_file_content", { path });
        const mtime = await invoke<number>("file_mtime_ms", { path }).catch(() => 0);
        if (live) openBuffer(path, content, mtime);
      } catch (err) {
        if (live) setLoadError(String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [path, buffer, openBuffer, isUntitled]);

  // ── Change bars and blame ──
  const refreshDiffGutter = useCallback(() => {
    if (isUntitled || !relPath) return;
    void gitDiffLineStatus(projectPath, relPath, false)
      .then((status) => decorations.setStatus(status))
      .catch(() => {});
  }, [decorations, projectPath, relPath, isUntitled]);

  // Blame is computed against the file on disk, so it is not fetched while
  // the buffer is dirty (line numbers would misalign): the decorations keep
  // the last snapshot, shifted through the edits, edited lines uncommitted.
  const refreshBlame = useCallback(() => {
    if (isUntitled || !relPath || !gitBlameInline) return;
    if (useEditorStore.getState().buffers[path]?.dirty) return;
    void gitBlameFile(projectPath, relPath)
      .then((lines) => decorations.setBlame(lines))
      .catch(() => {});
  }, [decorations, path, projectPath, relPath, isUntitled, gitBlameInline]);

  useEffect(() => {
    if (!gitBlameInline) decorations.setBlame(null);
  }, [decorations, gitBlameInline]);

  // ── Save ──
  const persistedMtime = useRef(0);
  const markClean = useCallback(
    (dirty: boolean) => {
      setDirty(path, dirty);
      layoutActions.setTabDirty(tabId, dirty);
    },
    [setDirty, layoutActions, path, tabId],
  );
  const save = useFileSaveCoordinator({
    path,
    baseline: buffer?.originalContent ?? "",
    persist: async (content) => {
      try {
        await invoke("write_file_content", { path, content });
        persistedMtime.current = await invoke<number>("file_mtime_ms", { path }).catch(() => 0);
        return true;
      } catch (err) {
        console.error("Save failed:", err);
        return false;
      }
    },
    onPendingChange: markClean,
    onConfirmed: (content) => {
      markSaved(path, content, persistedMtime.current);
      logEvent({
        source: "editor",
        kind: "save",
        summary: path.split("/").pop() ?? path,
        payload: { path, bytes: content.length },
      });
      // A save mutates the working tree: refresh git status and the diff now
      // instead of waiting for the watcher. Lazy, to keep the editor
      // decoupled from the git store.
      void import("@/features/git/stores/git-store").then(({ useGitStore }) => {
        const git = useGitStore.getState();
        if (git.repoPath) {
          void git.actions.refreshStatusNow(git.repoPath);
          void git.actions.loadDiff();
        }
      });
      refreshDiffGutter();
      refreshBlame();
    },
  });

  // Untitled buffers open the OS save dialog first; on commit the file is
  // written, the untitled tab is replaced by a real-path one, and the buffer
  // moves to the new key so that tab opens without a disk round trip.
  const saveAs = useCallback(async () => {
    const content = viewRef.current?.getText();
    if (content === undefined) return;
    try {
      const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
      const chosen = await saveDialog({
        defaultPath: projectPath || undefined,
        title: "Save File",
      });
      if (!chosen) return;
      const newPath = chosen as string;
      await invoke("write_file_content", { path: newPath, content });
      const mtime = await invoke<number>("file_mtime_ms", { path: newPath }).catch(() => 0);
      openBuffer(newPath, content, mtime);
      markSaved(newPath, content, mtime);
      layoutActions.closeTab(tabId);
      openFileAs(newPath, "text");
      logEvent({
        source: "editor",
        kind: "save",
        summary: newPath.split("/").pop() ?? newPath,
        payload: { path: newPath, bytes: content.length },
      });
    } catch (err) {
      console.error("Save-as failed:", err);
    }
  }, [projectPath, openBuffer, markSaved, layoutActions, tabId]);

  const handleSave = useCallback(() => {
    if (isUntitled) void saveAs();
    else void save.flush();
  }, [isUntitled, saveAs, save]);

  // ── External changes ──
  const replaceDocument = useCallback(
    (content: string, mtime: number) => {
      reloadBuffer(path, content, mtime);
      save.reset(content);
      setDocVersion((v) => v + 1);
      refreshDiffGutter();
      refreshBlame();
    },
    [path, reloadBuffer, save, refreshDiffGutter, refreshBlame],
  );

  // Reconcile with disk when the file may have changed externally (agent or
  // CLI edits). mtime-gated so an unchanged file costs one cheap IPC. A clean
  // buffer reloads silently; one with unsaved edits is only flagged, so the
  // user can reload from the header.
  const revalidate = useCallback(async () => {
    if (!path || isUntitled) return;
    const buf = useEditorStore.getState().buffers[path];
    if (!buf) return;
    const mtime = await invoke<number>("file_mtime_ms", { path }).catch(() => 0);
    if (!mtime || mtime <= buf.diskMtimeMs) return;
    let content: string;
    try {
      content = await invoke<string>("read_file_content", { path });
    } catch {
      return;
    }
    // Re-read: the buffer may have changed (dirty, gone) during the awaits.
    const cur = useEditorStore.getState().buffers[path];
    if (!cur) return;
    const liveDoc = viewRef.current?.getText() ?? cur.originalContent;
    if (content === liveDoc) {
      // Matches what's shown (our own save, say): just record the mtime.
      reloadBuffer(path, content, mtime);
      return;
    }
    if (cur.dirty) {
      markExternallyChanged(path, mtime);
      return;
    }
    replaceDocument(content, mtime);
  }, [path, isUntitled, reloadBuffer, markExternallyChanged, replaceDocument]);
  const revalidateRef = useRef(revalidate);
  revalidateRef.current = revalidate;

  // The user chose disk from the "changed on disk" pill: unsaved edits go.
  const forceReload = useCallback(async () => {
    if (!path || isUntitled) return;
    let content: string;
    try {
      content = await invoke<string>("read_file_content", { path });
    } catch {
      return;
    }
    const mtime = await invoke<number>("file_mtime_ms", { path }).catch(() => 0);
    replaceDocument(content, mtime);
  }, [path, isUntitled, replaceDocument]);

  // Repaint bars and blame when the working tree changes elsewhere (commits,
  // stage/unstage, external edits) — the event the git store listens to.
  useEffect(() => {
    const un = listen("atlas:git-changed", () => {
      refreshDiffGutter();
      refreshBlame();
    });
    return () => {
      void un.then((u) => u());
    };
  }, [refreshDiffGutter, refreshBlame]);

  // Reconcile with disk on the signals of an external edit: the buffer
  // mounting (a close-then-reopen must not show a stale cached buffer), the
  // working-tree watcher while the tab is open, and the window regaining
  // focus (editing in a CLI and switching back).
  const hasBuffer = !!buffer;
  useEffect(() => {
    if (!hasBuffer || isUntitled) return;
    void revalidateRef.current();
    // Every open file tab stays mounted and listening, and the watcher fires
    // per batch over the whole tree; one trailing revalidate per quiet window
    // answers the same question as one per event.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void revalidateRef.current(), REVALIDATE_DEBOUNCE_MS);
    };
    const un = listen("atlas:explorer:changed", soon);
    const onActive = () => void revalidateRef.current();
    window.addEventListener("atlas:window-active", onActive);
    return () => {
      clearTimeout(timer);
      void un.then((u) => u());
      window.removeEventListener("atlas:window-active", onActive);
    };
  }, [path, hasBuffer, isUntitled]);

  // Paint once the inputs settle (the project path can resolve after mount).
  useEffect(() => {
    if (!hasBuffer) return;
    refreshDiffGutter();
    refreshBlame();
  }, [hasBuffer, refreshDiffGutter, refreshBlame]);

  // ── Rendered or source ──
  const renderedMode = isUntitled ? null : renderedModeOf(path);
  const [renderedPreferred, setRenderedPreferred] = useState(() =>
    renderedMode ? readRenderedPreference(renderedMode) : false,
  );
  // A reveal is a line in the source, so a pending one shows the source.
  const rendered = renderedMode !== null && renderedPreferred && !pendingReveal;
  // The code view mounts on first need and then stays, hidden while the
  // rendered view shows, so its document and undo history survive a toggle.
  const [sourceMounted, setSourceMounted] = useState(!rendered);
  if (!rendered && !sourceMounted) setSourceMounted(true);
  // What the rendered view shows: the live document at the moment it was
  // asked for, or the file as read.
  const [renderedText, setRenderedText] = useState<string | null>(null);
  const toggleRendered = () => {
    if (!renderedMode) return;
    const next = !rendered;
    if (next) setRenderedText(viewRef.current?.getText() ?? null);
    setRenderedPreferred(next);
    writeRenderedPreference(renderedMode, next);
  };
  useEffect(() => {
    setRenderedText(null);
  }, [docVersion]);

  // ── Keys, position, layout ──
  useScopedHotkeys({
    tabId,
    handlers: {
      "editor.save": () => {
        handleSave();
      },
      "editor.find": () => {
        if (rendered) return false;
        // Focus inside the editor: its own ⌘F opens the panel.
        if (document.activeElement?.closest?.("[data-file-view]")) return false;
        return viewRef.current?.openFind() ?? false;
      },
    },
  });

  useEffect(() => registerEditorView(tabId, () => viewRef.current?.position()), [tabId]);

  useEffect(() => {
    decorations.setLayout(wordWrap, gitBlameInline);
  }, [decorations, wordWrap, gitBlameInline]);

  if (loadError) {
    return (
      <div className="flex h-full flex-col bg-background">
        <FileSurfaceFailure
          message="This file can't be shown as text. It may be binary, or it couldn't be read."
          detail={path}
          action={
            <Button variant="outline" size="xs" onClick={() => setLoadError(null)}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
  if (!buffer) {
    return (
      <div className="flex h-full flex-col bg-background">
        <FileSurfaceLoading />
      </div>
    );
  }

  const large = buffer.originalContent.length > LARGE_FILE_CHARS;
  const delimiter = renderedMode === "table" ? filePreviewDelimiter({ name: path }) : null;
  const shownText = renderedText ?? buffer.originalContent;
  const name = path.split("/").pop() ?? path;
  const crumbs: FileBreadcrumbsProps | null = crumbTarget
    ? {
        root: crumbTarget.root,
        projectName: crumbTarget.projectName,
        relativePath: crumbTarget.current,
        trail: crumbTarget.trail,
        onNavigate: navigateCrumb,
        onOpenFile: (abs) => void openInProject(abs),
        identity: frame?.titled === false ? { path, dirty: buffer.dirty } : null,
      }
    : null;

  return (
    <div
      className="flex flex-col overflow-hidden bg-background"
      style={{ height: containerHeight || "100%" }}
    >
      <div
        className={cn(
          "flex items-center gap-2 overflow-hidden bg-background px-3",
          FILE_SURFACE_SUBHEADER_CLASS,
        )}
        data-surface-subheader
      >
        {crumbs ? (
          <FileBreadcrumbsRow {...crumbs} className="shrink" />
        ) : (
          <UntitledName
            name={name}
            identity={frame?.titled === false ? { path, dirty: buffer.dirty } : null}
          />
        )}
        {!rendered && <HeaderBlame decorations={decorations} />}
        {/* `ml-auto` on the group, not on whichever child happens to render,
            keeps the controls pinned right whichever of them are present. */}
        <div className="ml-auto flex items-center gap-1 pl-2">
          {buffer.externallyChanged && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => void forceReload()}
              title="This file changed on disk. Reload discards your unsaved edits."
            >
              <RefreshCw size={10} aria-hidden /> Disk changed · Reload
            </Button>
          )}
          {renderedMode && (
            <FileSurfaceAction
              label={renderedToggleLabel(renderedMode, rendered)}
              icon={rendered ? Code2 : renderedMode === "table" ? Table2 : Eye}
              pressed={rendered}
              onPress={toggleRendered}
            />
          )}
          {!rendered && (
            <FileSurfaceAction
              label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
              icon={WrapText}
              pressed={wordWrap}
              onPress={toggleWordWrap}
            />
          )}
          {!isUntitled && (
            <OpenInEditorButton
              path={path}
              position={() => {
                if (rendered) return undefined;
                const at = viewRef.current?.position();
                return at ? { line: at.cursor.line, column: at.cursor.col } : undefined;
              }}
            />
          )}
        </div>
      </div>
      {large && !rendered && (
        <FileSurfaceNotice>
          {`Large file (${(buffer.originalContent.length / 1024 / 1024).toFixed(1)} MB): shown read-only, without highlighting.`}
        </FileSurfaceNotice>
      )}
      {sourceMounted && (
        <div className={rendered ? "hidden" : "flex min-h-0 flex-1"}>
          <CodeFileView
            key={path}
            handleRef={viewRef}
            name={path}
            contents={buffer.originalContent}
            version={docVersion}
            wordWrap={wordWrap}
            readOnly={large}
            decorations={decorations}
            reveal={pendingReveal}
            onRevealed={(nonce) => consumeReveal(path, nonce)}
            onChange={(content) => save.change(content)}
          />
        </div>
      )}
      {rendered && renderedMode === "markdown" && (
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          <MarkdownFile trusted docPath={path} className="mx-auto max-w-4xl">
            {shownText}
          </MarkdownFile>
        </div>
      )}
      {rendered && renderedMode === "table" && delimiter && (
        <DelimitedTablePreview name={name} text={shownText} delimiter={delimiter} />
      )}
      {rendered && renderedMode === "html" && <HtmlPreview html={shownText} title={name} />}
    </div>
  );
}

/** The cursor line's blame beside the breadcrumbs, for a wrapping view: it
 *  takes what the crumbs leave and truncates first. Subscribes on its own, so a cursor
 *  move repaints this and nothing else. */
function HeaderBlame({ decorations }: { decorations: FileDecorations }) {
  const parts = useSyncExternalStore(decorations.subscribe, decorations.headerBlame);
  if (!parts) return null;
  const label = parts.map((p) => p.text).join("");
  return (
    <span
      className="ml-1 min-w-0 flex-1 basis-0 truncate text-xs italic opacity-80 select-none"
      title={label}
    >
      {parts.map((part, i) => (
        <span key={i} style={{ color: BLAME_PART_COLOR[part.kind] }}>
          {part.text}
        </span>
      ))}
    </span>
  );
}

/** An untitled buffer has no path to crumb: its name alone, and where no
 *  tab names it, its icon and unsaved dot too. */
function UntitledName({
  name,
  identity,
}: {
  name: string;
  identity: { path: string; dirty: boolean } | null;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      {identity && <FileIcon path={identity.path} size={14} className="shrink-0" />}
      <span className="truncate px-0.5 font-medium text-foreground">{name}</span>
      {identity?.dirty && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-primary"
          role="img"
          aria-label="Unsaved changes"
        />
      )}
    </span>
  );
}

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

/**
 * Confirm-before-removing-an-agent, driven the same way as the stop-agents
 * prompt: the caller `ask()`s and awaits a boolean, `RemoveAgentDialog`
 * (mounted once in App) renders whatever is pending.
 *
 * This replaced `window.confirm`. WebView2 answers `confirm()` with `true`
 * and shows NO dialog, so on Windows the marketplace's Remove fired with no
 * confirmation at all — and a keypress meant for the dialog landed on the
 * card underneath. An in-app dialog behaves the same on every platform.
 */

export interface RemoveAgentPrompt {
  /** Display name for the copy: "Remove Claude Agent?" */
  name: string;
}

interface RemoveAgentConfirmState {
  pending: (RemoveAgentPrompt & { resolve: (ok: boolean) => void }) | null;
  actions: {
    ask: (prompt: RemoveAgentPrompt) => Promise<boolean>;
    settle: (ok: boolean) => void;
  };
}

const useRemoveAgentConfirmStoreBase = create<RemoveAgentConfirmState>((set, get) => ({
  pending: null,
  actions: {
    ask: (prompt) =>
      new Promise<boolean>((resolve) => {
        // A newer ask supersedes an unanswered one — decline the old caller
        // so its promise never dangles.
        get().pending?.resolve(false);
        set({ pending: { ...prompt, resolve } });
      }),
    settle: (ok) => {
      const p = get().pending;
      if (!p) return;
      set({ pending: null });
      p.resolve(ok);
    },
  },
}));

export const useRemoveAgentConfirmStore = createSelectors(useRemoveAgentConfirmStoreBase);

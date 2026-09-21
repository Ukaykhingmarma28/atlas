/**
 * Types for `app-icons.mjs`, which is plain Node ESM so it can run with no
 * build step. Only the surface `tests/app-icons.test.ts` imports is declared.
 */

export interface AppIconManifest {
  default: string;
  icons: { id: string; label: string }[];
}

/** Absolute path of `src-tauri/icons/app-icons`. */
export const ICONS_DIR: string;
export function readManifest(): AppIconManifest;
/** sha256 of the default id and every source file; what `sources.sha256` records. */
export function sourcesHash(manifest?: AppIconManifest): string;
/** Why the committed renders are stale; empty when they are current. */
export function staleOutputs(manifest?: AppIconManifest): string[];

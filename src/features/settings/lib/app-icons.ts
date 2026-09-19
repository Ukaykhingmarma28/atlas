/**
 * The selectable macOS app icons. The list lives in the Rust side's icon
 * directory, next to the Icon Composer sources it names, so the render script,
 * `src-tauri/src/app_icon.rs` and this picker all read one manifest.
 * Add an icon there, then run `bun run icons:render`.
 */
import manifest from "../../../../src-tauri/icons/app-icons/app-icons.json";

export interface AppIconOption {
  id: string;
  label: string;
}

export const APP_ICONS: readonly AppIconOption[] = manifest.icons;

/** The bundle's own Liquid Glass icon. */
export const DEFAULT_APP_ICON: string = manifest.default;

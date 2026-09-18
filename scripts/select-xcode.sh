# shellcheck shell=bash
# ============================================================================
# Sourced by the macOS build scripts: make sure `actool` resolves to Xcode 26+.
#
# Tauri compiles the Liquid Glass app icon (src-tauri/icons/AtlasIcon.icon)
# into Assets.car with `actool`. When it can't — `xcode-select` pointing at the
# Command Line Tools, which have no actool, or an Xcode older than 26 — it
# prints a warning and carries on, and the app silently ships with only the
# flat Icon.icns. `/usr/bin/actool` honours DEVELOPER_DIR, so when the active
# developer dir can't run it but /Applications/Xcode.app can, point there for
# this build instead of asking for a `sudo xcode-select -s`.
#
# Sets ATLAS_ACTOOL_OK=1 when actool 26+ is usable, 0 otherwise; the caller
# decides whether that is fatal.
# ============================================================================

actool_major() {
  actool --version --output-format human-readable-text 2>/dev/null \
    | sed -n 's/^short-bundle-version: \([0-9]*\).*/\1/p'
}

if [[ -z "$(actool_major)" && -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

if [[ "$(actool_major)" -ge 26 ]] 2>/dev/null; then
  ATLAS_ACTOOL_OK=1
else
  ATLAS_ACTOOL_OK=0
fi

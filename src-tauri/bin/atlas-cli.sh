#!/usr/bin/env bash
# atlas-cli-version: {{VERSION}}
# {{VERSION}} is substituted at install time from CARGO_PKG_VERSION
# (src-tauri/Cargo.toml), not tauri.conf.json's `version` field —
# the two can drift.
#
# Atlas CLI helper. Installed (and refreshed on every launch) by the
# Atlas IDE at `~/.local/bin/atlas`. Mirrors the `code` (VS Code) and
# `zed` (Zed) CLIs: run `atlas` in a terminal to open the current
# folder, or `atlas <path>` to open any directory.
#
# Re-installing Atlas overwrites this file in place — never hand-edit;
# changes won't survive a launch.

set -e

cmd="${1:-}"

case "$cmd" in
  --version|-v)
    echo "atlas {{VERSION}}"
    exit 0
    ;;
  --help|-h)
    cat <<'USAGE'
Usage:
  atlas              open the current directory in Atlas
  atlas <path>       open <path> in Atlas
  atlas --version    print the IDE version
  atlas --help       this message

Atlas opens each invocation as its own window so you can have many
projects in flight at once. The folder you pass must exist and be
readable.
USAGE
    exit 0
    ;;
esac

target="${1:-.}"

# Resolve to an absolute path. We deliberately use `cd && pwd` rather
# than `realpath` because realpath isn't on every macOS by default and
# this is portable.
if [ ! -d "$target" ]; then
  echo "atlas: not a directory: $target" >&2
  exit 1
fi
abs="$(cd "$target" && pwd)"

# Find Atlas.app. macOS first looks in /Applications, then
# ~/Applications, then PATH-y locations via `mdfind`. The latter
# covers DMG drag-installs to unusual locations.
# "Atlas.app" (below and in the LaunchServices fallback) must match
# `productName` in src-tauri/tauri.conf.json.
app=""
for candidate in \
  "/Applications/Atlas.app" \
  "$HOME/Applications/Atlas.app"; do
  if [ -d "$candidate" ]; then
    app="$candidate"
    break
  fi
done
if [ -z "$app" ] && command -v mdfind >/dev/null 2>&1; then
  # Identifier must match `identifier` in src-tauri/tauri.conf.json.
  app="$(mdfind "kMDItemCFBundleIdentifier == 'dev.atlas.ide'" 2>/dev/null | head -n 1)"
fi
if [ -z "$app" ] && [ -x "/usr/bin/atlas" ]; then
  app="/usr/bin/atlas"
fi
if [ -z "$app" ] && [ "$(uname -s)" = "Darwin" ]; then
  app="Atlas.app"  # let `open` resolve via LaunchServices as a fallback
fi

# On macOS, `-n` forces a fresh process so argv is actually delivered;
# single-instance intercepts it if Atlas is already running.
# On Linux, exec the binary directly.
if [ "$(uname -s)" = "Darwin" ]; then
  exec open -na "$app" --args "$abs"
else
  exec "${app:-atlas}" "$abs"
fi


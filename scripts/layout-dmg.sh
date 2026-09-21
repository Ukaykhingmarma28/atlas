#!/usr/bin/env bash
# ============================================================================
# Lay out a writable Atlas .dmg with the custom Finder background + icon
# positions, then convert it to a compressed, read-only image.
#
# release-macos.sh hand-rolls its DMG with a bare `hdiutil create` instead of
# Tauri's bundle_dmg.sh (see that script's header for why) — which means
# tauri.conf.json's `bundle.macOS.dmg` config (background/windowSize/
# appPosition/applicationFolderPosition) never applies to the shipped dmg.
# This script is that step done by hand: create a writable image, mount it,
# drive Finder via AppleScript to set the window bounds/background/icon
# layout (Finder persists that into the volume's .DS_Store), then unmount
# and compress.
#
# Window/icon numbers below were measured directly from the reference
# dmg-preview build's .DS_Store, and mirror what's in tauri.conf.json's
# bundle.macOS.dmg (kept in sync manually since this path bypasses it).
#
# Usage:
#   scripts/layout-dmg.sh <staging-dir> <output.dmg> [volname]
#
# <staging-dir> must already contain Atlas.app and an Applications symlink.
# ============================================================================

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

staging="${1:?usage: layout-dmg.sh <staging-dir> <output.dmg> [volname]}"
out_dmg="${2:?usage: layout-dmg.sh <staging-dir> <output.dmg> [volname]}"
volname="${3:-Atlas}"

background="${root}/src-tauri/icons/dmg-background.png"
if [[ ! -f "${background}" ]]; then
  echo "layout-dmg: background not found at ${background}" >&2
  exit 1
fi
if [[ ! -d "${staging}/Atlas.app" ]]; then
  echo "layout-dmg: ${staging}/Atlas.app not found" >&2
  exit 1
fi

WINDOW_WIDTH=512
# 320 (the background art's design height) + 32 for Finder's Path Bar, which
# is a per-user Finder preference we can't control or detect from here. If
# it's off (the macOS default) the extra 32pt is just more of the tileable
# dot background below the icons; if it's on, it's exactly what the path bar
# needs, so the background never comes up short either way.
WINDOW_HEIGHT=352
ICON_SIZE=128
APP_POS_X=140
APP_POS_Y=160
APPS_POS_X=372
APPS_POS_Y=160

mkdir -p "${staging}/.background"
cp "${background}" "${staging}/.background/dmg-background.png"

volume_icon="${root}/src-tauri/icons/dmg-icon.icns"

rw_dmg="$(mktemp -u "${TMPDIR:-/tmp}/atlas-layout-XXXXXX").dmg"
mount_point=""

cleanup() {
  if [[ -n "${mount_point}" && -d "${mount_point}" ]]; then
    hdiutil detach "${mount_point}" -force >/dev/null 2>&1 || true
  fi
  rm -f "${rw_dmg}"
}
trap cleanup EXIT

hdiutil create \
  -volname "${volname}" \
  -srcfolder "${staging}" \
  -ov \
  -fs HFS+ \
  -format UDRW \
  "${rw_dmg}" >/dev/null

# No explicit -mountpoint: Finder only lists volumes mounted under /Volumes as
# a "disk" it can `tell` — an explicit mountpoint elsewhere (e.g. under
# $TMPDIR) attaches fine but is invisible to Finder, and every `tell disk
# "<name>"` below fails with "Can't get disk ... (-1728)". Let hdiutil pick
# the /Volumes path (handling name collisions itself) and read it back.
attach_output="$(hdiutil attach "${rw_dmg}" -readwrite -noverify -noautoopen)"
mount_point="$(printf '%s\n' "${attach_output}" | grep -o '/Volumes/.*$' | tail -n1)"
if [[ -z "${mount_point}" ]]; then
  echo "layout-dmg: couldn't determine mount point from:" >&2
  printf '%s\n' "${attach_output}" >&2
  exit 1
fi
# The mounted name may differ from ${volname} if another volume with that
# name is already mounted (hdiutil appends " 1", " 2", ...) — Finder needs
# the actual name it's showing, not the one we asked for.
mounted_volname="$(basename "${mount_point}")"

# Finder discovers a freshly-mounted volume asynchronously — `tell disk
# volname` right after `hdiutil attach` intermittently fails with "Can't get
# disk ... (-1728)" because Finder hasn't registered it yet. Poll until it has.
for _ in $(seq 1 30); do
  if osascript -e "tell application \"Finder\" to exists disk \"${mounted_volname}\"" 2>/dev/null | grep -qx true; then
    break
  fi
  sleep 0.5
done

# The straightforward version of this (set bounds once, close, reopen) does
# not reliably "stick" — Finder silently settles on a window a few dozen
# points taller/wider than requested, so the content area ends up smaller
# than the background image and it reads as cropped/misaligned. This is a
# known Finder quirk; the fix (shrink the window by 10pt, wait, then set it
# back to the real target size, across a fresh `tell disk` block) is lifted
# verbatim from Tauri's own bundle_dmg AppleScript template
# (crates/tauri-bundler/src/bundle/macos/dmg/template.applescript) — the
# exact recipe its native DMG bundler uses, battle-tested across every Tauri
# app that ships a styled dmg.
osascript <<EOF
tell application "Finder"
  tell disk "${mounted_volname}"
    open
    set theXOrigin to 100
    set theYOrigin to 100
    set theWidth to ${WINDOW_WIDTH}
    set theHeight to ${WINDOW_HEIGHT}
    set theBottomRightX to (theXOrigin + theWidth)
    set theBottomRightY to (theYOrigin + theHeight)
    tell container window
      set current view to icon view
      set toolbar visible to false
      set statusbar visible to false
      set the bounds to {theXOrigin, theYOrigin, theBottomRightX, theBottomRightY}
    end tell
    set theViewOptions to the icon view options of container window
    tell theViewOptions
      set icon size to ${ICON_SIZE}
      set arrangement to not arranged
    end tell
    set background picture of theViewOptions to file ".background:dmg-background.png"
    set position of item "Atlas.app" of container window to {${APP_POS_X}, ${APP_POS_Y}}
    set position of item "Applications" of container window to {${APPS_POS_X}, ${APPS_POS_Y}}
    close
    open
    -- Force Finder to actually commit to the target size: shrink slightly,
    -- let it settle, then restore to the real target bounds.
    delay 1
    tell container window
      set statusbar visible to false
      set the bounds to {theXOrigin, theYOrigin, theBottomRightX - 10, theBottomRightY - 10}
    end tell
  end tell

  delay 1

  tell disk "${mounted_volname}"
    tell container window
      set statusbar visible to false
      set the bounds to {100, 100, 100 + ${WINDOW_WIDTH}, 100 + ${WINDOW_HEIGHT}}
    end tell
  end tell

  update disk "${mounted_volname}" without registering applications
  delay 3
end tell
EOF

# The mounted volume's own icon (what shows in Finder's sidebar/Desktop while
# it's mounted) is separate from the outer .dmg file's icon that
# scripts/set-dmg-icon.sh stamps — that one only covers the .dmg as it sits
# on disk before mounting. A volume picks up its custom icon from a
# `.VolumeIcon.icns` file at its root plus the "has custom icon" Finder flag
# on the root itself — but Finder's own open/close/"update disk" dance above
# treats an icon set any earlier than this as a stale orphan and strips both
# the file and the flag as part of its housekeeping. Apply it only now, after
# Finder is done styling and before we ever touch the volume again.
if [[ -f "${volume_icon}" ]]; then
  cp "${volume_icon}" "${mount_point}/.VolumeIcon.icns"
  SetFile -c icnC "${mount_point}/.VolumeIcon.icns"
  SetFile -a C "${mount_point}"
fi

sync
hdiutil detach "${mount_point}" >/dev/null

rm -f "${out_dmg}"
hdiutil convert "${rw_dmg}" -format UDZO -ov -o "${out_dmg}" >/dev/null

echo "layout-dmg: wrote ${out_dmg}"

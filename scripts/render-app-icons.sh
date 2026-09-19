#!/usr/bin/env bash
# ============================================================================
# Render the Light Liquid Glass app icon to src-tauri/icons/AtlasLight.icns.
#
# The dark icon needs no render: it IS the bundle icon (AtlasIcon.icon, which
# Tauri compiles into Assets.car, with Icon.icns as the pre-macOS-26
# fallback). The light one is only ever applied at runtime, as the Dock icon,
# when Settings → General → App icon is "Light" — see src-tauri/src/app_icon.rs.
# Tauri compiles just one .icon, so this variant ships as a pre-rendered .icns
# resource instead.
#
# Re-run after editing the Light .icon in Icon Composer, and commit the result.
# Needs Xcode 26+ (for Icon Composer's `ictool`).
#
# Usage:
#   scripts/render-app-icons.sh
# ============================================================================

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_icon="${root}/src-tauri/icons/icon-composer-source/Atlas Light- Style.icon"
out_icns="${root}/src-tauri/icons/AtlasLight.icns"

xcode="$(xcode-select -p)"
[[ "${xcode}" == */CommandLineTools ]] && xcode="/Applications/Xcode.app/Contents/Developer"
ictool="${xcode}/../Applications/Icon Composer.app/Contents/Executables/ictool"
if [[ ! -x "${ictool}" ]]; then
  echo "render-app-icons: ictool not found at ${ictool} (needs Xcode 26+)" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

# ictool renders the icon edge to edge. macOS icons sit on Apple's grid: an
# 824pt body centred in a 1024pt canvas — the same inset actool gives its own
# .icns fallback — so render at 824 and pad out to 1024.
"${ictool}" "${source_icon}" --export-image --output-file "${tmp}/body.png" \
  --platform macOS --rendition Default --width 412 --height 412 --scale 2 >/dev/null
sips --padToHeightWidth 1024 1024 "${tmp}/body.png" --out "${tmp}/1024.png" >/dev/null

iconset="${tmp}/AtlasLight.iconset"
mkdir -p "${iconset}"
for size in 16 32 128 256 512; do
  sips -z "${size}" "${size}" "${tmp}/1024.png" --out "${iconset}/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "${double}" "${double}" "${tmp}/1024.png" --out "${iconset}/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "${iconset}" -o "${out_icns}"

echo "render-app-icons: wrote ${out_icns#"${root}/"}"

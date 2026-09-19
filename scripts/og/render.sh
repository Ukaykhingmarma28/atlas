#!/usr/bin/env bash
# Renders scripts/og/og.html to landing/og-image.webp (1200×630 at 2×) with the
# local Chrome. macOS: the page uses the system SF faces.
#
# Chrome only screenshots PNG, so the PNG is an intermediate in a temp dir and
# never lands in the repo — the committed image is the WebP alone. q82 is where
# the dither field's 1px glyphs and the near-black gradient still survive
# (checked by eye against the lossless encode); it lands ~175 KB against ~1 MB
# of PNG.
set -euo pipefail
cd "$(dirname "$0")/../.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --allow-file-access-from-files --force-device-scale-factor=2 \
  --window-size=1200,630 --virtual-time-budget=2000 \
  --screenshot="$TMP/og.png" \
  "file://$PWD/scripts/og/og.html"
cwebp -quiet -q 82 -m 6 "$TMP/og.png" -o "$PWD/landing/og-image.webp"
echo "landing/og-image.webp: $(du -h "$PWD/landing/og-image.webp" | cut -f1)"

#!/usr/bin/env bash
# Renders scripts/og/og.html to landing/og-image.webp and landing/og-image.jpg
# (1200×630 at 2×) with the local Chrome. macOS: the page uses the system SF
# faces.
#
# Chrome only screenshots PNG, so the PNG is an intermediate in a temp dir and
# never lands in the repo. Two encodes ship:
#
#   webp q82  ~177 KB  the good one, and what X/Slack/Discord/iMessage get
#   jpeg q80  ~323 KB  the fallback, and the primary og:image
#
# The JPEG exists because LinkedIn and Facebook are unreliable with WebP link
# previews — they can render nothing at all. It is listed first in index.html
# for that reason: crawlers take the first og:image they find, so the order is
# what decides which file the world actually sees. Both quality levels are
# where the dither field's 1px glyphs and the near-black gradient still
# survive, checked by eye against the lossless encode.
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
cjpeg -quality 80 -progressive -optimize -outfile "$PWD/landing/og-image.jpg" "$TMP/og.png"
# Real byte counts, not du's allocated blocks — those overreport by ~30% here.
for f in landing/og-image.webp landing/og-image.jpg; do
  echo "$f: $(( $(wc -c < "$PWD/$f") / 1024 )) KB"
done

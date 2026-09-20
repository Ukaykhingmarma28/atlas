#!/usr/bin/env bash
# ============================================================================
# Atlas — Linux packaging script
#
# Generates:
#   1. Standalone portable tarball (atlas-<version>-linux-<arch>.tar.gz)
#      with binary, desktop integration, icons, licenses, and installer scripts.
#   2. AUR `atlas-bin` PKGBUILD with calculated checksums.
#
# Usage:
#   scripts/package-linux.sh [x86_64|aarch64]
# ============================================================================

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

ARCH="${1:-x86_64}"
case "$ARCH" in
  x86_64|x64|amd64)
    ARCH="x86_64"
    RUST_TARGET="x86_64-unknown-linux-gnu"
    ;;
  aarch64|arm64)
    ARCH="aarch64"
    RUST_TARGET="aarch64-unknown-linux-gnu"
    ;;
  *)
    echo "Unknown architecture: $ARCH" >&2
    exit 1
    ;;
esac

# Extract version from package.json
VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')"
VERSION="${VERSION#v}"
echo "Packaging Atlas v${VERSION} for Linux (${ARCH})..."

# Locate binary
ATLAS_BIN="${ATLAS_BIN:-}"
if [ -z "$ATLAS_BIN" ]; then
  CANDIDATES=(
    "target/release/atlas"
    "target/${RUST_TARGET}/release/atlas"
  )
  for c in "${CANDIDATES[@]}"; do
    if [ -f "$c" ] && [ -x "$c" ]; then
      ATLAS_BIN="$c"
      break
    fi
  done
fi

if [ -z "$ATLAS_BIN" ] || [ ! -f "$ATLAS_BIN" ]; then
  echo "WARNING: atlas binary not found in standard target locations."
  echo "You can set ATLAS_BIN=/path/to/atlas before running this script."
  # If running in dummy/test mode without binary, create a placeholder if requested
  if [ "${CREATE_DUMMY_BIN:-0}" = "1" ]; then
    mkdir -p target/release
    ATLAS_BIN="target/release/atlas"
    echo '#!/bin/sh' > "$ATLAS_BIN"
    echo 'echo "Atlas"' >> "$ATLAS_BIN"
    chmod +x "$ATLAS_BIN"
  else
    echo "Error: Atlas binary required for packaging." >&2
    exit 1
  fi
fi

OUTPUT_DIR="${ROOT_DIR}/dist/release-linux"
rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}"

STAGE_DIR="${OUTPUT_DIR}/atlas-${VERSION}"
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}/bin"
mkdir -p "${STAGE_DIR}/share/applications"
mkdir -p "${STAGE_DIR}/share/licenses/atlas"

# 1. Copy binary
cp "$ATLAS_BIN" "${STAGE_DIR}/bin/atlas"
chmod 755 "${STAGE_DIR}/bin/atlas"

# 2. Copy desktop file
cp "src-tauri/resources/dev.atlas.ide.desktop" "${STAGE_DIR}/share/applications/"
chmod 644 "${STAGE_DIR}/share/applications/dev.atlas.ide.desktop"

# 3. Copy icons into hicolor theme hierarchy
mkdir -p "${STAGE_DIR}/share/icons/hicolor/32x32/apps"
mkdir -p "${STAGE_DIR}/share/icons/hicolor/64x64/apps"
mkdir -p "${STAGE_DIR}/share/icons/hicolor/128x128/apps"
mkdir -p "${STAGE_DIR}/share/icons/hicolor/256x256/apps"
mkdir -p "${STAGE_DIR}/share/icons/hicolor/512x512/apps"

[ -f "src-tauri/icons/32x32.png" ] && cp "src-tauri/icons/32x32.png" "${STAGE_DIR}/share/icons/hicolor/32x32/apps/atlas.png"
[ -f "src-tauri/icons/64x64.png" ] && cp "src-tauri/icons/64x64.png" "${STAGE_DIR}/share/icons/hicolor/64x64/apps/atlas.png"
[ -f "src-tauri/icons/128x128.png" ] && cp "src-tauri/icons/128x128.png" "${STAGE_DIR}/share/icons/hicolor/128x128/apps/atlas.png"
[ -f "src-tauri/icons/128x128@2x.png" ] && cp "src-tauri/icons/128x128@2x.png" "${STAGE_DIR}/share/icons/hicolor/256x256/apps/atlas.png"
[ -f "src-tauri/icons/icon.png" ] && cp "src-tauri/icons/icon.png" "${STAGE_DIR}/share/icons/hicolor/512x512/apps/atlas.png"

# 4. Copy licenses
[ -f "LICENSE" ] && cp "LICENSE" "${STAGE_DIR}/share/licenses/atlas/LICENSE"
if [ -d "src-tauri/licenses" ]; then
  cp src-tauri/licenses/* "${STAGE_DIR}/share/licenses/atlas/"
fi

# 5. Add installer & uninstaller scripts
cat <<'EOF' > "${STAGE_DIR}/install.sh"
#!/usr/bin/env bash
set -euo pipefail
PREFIX="${PREFIX:-/usr/local}"
if [ "$EUID" -ne 0 ] && [ "$PREFIX" = "/usr/local" ]; then
  PREFIX="${HOME}/.local"
fi
echo "Installing Atlas to ${PREFIX}..."
install -d "${PREFIX}/bin" "${PREFIX}/share/applications" "${PREFIX}/share/licenses/atlas"
install -m 755 bin/atlas "${PREFIX}/bin/atlas"
install -m 644 share/applications/dev.atlas.ide.desktop "${PREFIX}/share/applications/dev.atlas.ide.desktop"
ln -sf dev.atlas.ide.desktop "${PREFIX}/share/applications/atlas.desktop" || cp share/applications/dev.atlas.ide.desktop "${PREFIX}/share/applications/atlas.desktop"
cp -r share/icons "${PREFIX}/share/"
cp -r share/licenses/atlas/* "${PREFIX}/share/licenses/atlas/"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${PREFIX}/share/applications" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t "${PREFIX}/share/icons/hicolor" 2>/dev/null || true
fi
echo "Atlas installed successfully to ${PREFIX}!"
EOF
chmod 755 "${STAGE_DIR}/install.sh"

cat <<'EOF' > "${STAGE_DIR}/uninstall.sh"
#!/usr/bin/env bash
set -euo pipefail
PREFIX="${PREFIX:-/usr/local}"
if [ "$EUID" -ne 0 ] && [ "$PREFIX" = "/usr/local" ]; then
  PREFIX="${HOME}/.local"
fi
echo "Uninstalling Atlas from ${PREFIX}..."
rm -f "${PREFIX}/bin/atlas"
rm -f "${PREFIX}/share/applications/dev.atlas.ide.desktop"
rm -f "${PREFIX}/share/applications/atlas.desktop"
for size in 32 64 128 256 512; do
  rm -f "${PREFIX}/share/icons/hicolor/${size}x${size}/apps/atlas.png"
done
rm -rf "${PREFIX}/share/licenses/atlas"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${PREFIX}/share/applications" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t "${PREFIX}/share/icons/hicolor" 2>/dev/null || true
fi
echo "Atlas uninstalled."
EOF
chmod 755 "${STAGE_DIR}/uninstall.sh"

# 6. Create tarball
TARBALL_NAME="atlas-${VERSION}-linux-${ARCH}.tar.gz"
TARBALL_PATH="${OUTPUT_DIR}/${TARBALL_NAME}"
tar -czf "${TARBALL_PATH}" -C "${OUTPUT_DIR}" "atlas-${VERSION}"
echo "Created standalone tarball: ${TARBALL_PATH}"

# Calculate SHA256 of the tarball
TARBALL_SHA256="$(sha256sum "${TARBALL_PATH}" | awk '{print $1}')"
echo "Tarball SHA256: ${TARBALL_SHA256}"

# 7. Generate AUR PKGBUILD
AUR_DIR="${OUTPUT_DIR}/aur-atlas-bin"
mkdir -p "${AUR_DIR}"
REPO="${GITHUB_REPOSITORY:-pacifio/atlas}"

cat <<EOF > "${AUR_DIR}/PKGBUILD"
# Maintainer: Atlas Team <contact@tryatlas.cc>
pkgname=atlas-bin
_pkgname=atlas
pkgver=${VERSION}
pkgrel=1
pkgdesc="Atlas — agent-first ideation and planning tool"
arch=('x86_64')
url="https://tryatlas.cc"
license=('Apache-2.0')
depends=(
    'webkit2gtk-4.1'
    'gtk3'
    'libayatana-appindicator'
    'bubblewrap'
    'openssl'
)
optdepends=(
    'xdg-terminal-exec: Open folders in default terminal'
)
provides=("atlas=\${pkgver}")
conflicts=('atlas')
source_x86_64=("atlas-\${pkgver}-linux-x86_64.tar.gz::https://github.com/${REPO}/releases/download/v\${pkgver}/atlas-\${pkgver}-linux-x86_64.tar.gz")
sha256sums_x86_64=('${TARBALL_SHA256}')

package() {
    cd "\${srcdir}/atlas-\${pkgver}"
    install -Dm755 bin/atlas "\${pkgdir}/usr/bin/atlas"
    install -Dm644 share/applications/dev.atlas.ide.desktop "\${pkgdir}/usr/share/applications/dev.atlas.ide.desktop"
    ln -sf dev.atlas.ide.desktop "\${pkgdir}/usr/share/applications/atlas.desktop"
    for size in 32 64 128 256 512; do
        if [ -f "share/icons/hicolor/\${size}x\${size}/apps/atlas.png" ]; then
            install -Dm644 "share/icons/hicolor/\${size}x\${size}/apps/atlas.png" \\
                "\${pkgdir}/usr/share/icons/hicolor/\${size}x\${size}/apps/atlas.png"
        fi
    done
    install -d "\${pkgdir}/usr/share/licenses/\${pkgname}"
    install -m644 share/licenses/atlas/* "\${pkgdir}/usr/share/licenses/\${pkgname}/"
}
EOF

# Copy tarball to AUR dir so makepkg can build offline/locally
cp "${TARBALL_PATH}" "${AUR_DIR}/"


echo "Created AUR PKGBUILD: ${AUR_DIR}/PKGBUILD"
echo "Packaging complete in ${OUTPUT_DIR}"

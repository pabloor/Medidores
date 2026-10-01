#!/bin/bash
# Construye Medidores.app para Apple Silicon (arm64) e Intel (x64) y deja un ZIP de cada una en dist/.
# Se puede ejecutar en Linux o macOS. Necesita Node.js y conexión a internet (descarga Electron).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STAGE="$ROOT/build/stage"
DIST="$ROOT/dist"
rm -rf "$ROOT/build/stage" "$ROOT/build/out" "$ROOT/build/icon" "$ROOT"/build/pkg-* "$DIST"
mkdir -p "$STAGE" "$DIST" "$ROOT/build/zips"
EV=$(node -p "require('electron/package.json').version")

echo "==> Preparando el contenido de la app"
VERSION="${VERSION:-$(date -u +%Y%m%d-%H%M)}"   # orden alfabético = orden cronológico; el workflow la fija para que coincida con el tag
echo "==> Versión $VERSION"
cp app/main.js app/app-main.js app/updater.js app/package.json LICENSE "$STAGE/"
echo "{\"version\":\"$VERSION\"}" > "$STAGE/version.json"
for d in medidores medidores-solo; do
  mkdir -p "$STAGE/$d"
  (cd "$d" && tar cf - --exclude=node_modules --exclude='*.command' --exclude=config.json --exclude=prefs.json --exclude=shure.json --exclude='README*' --exclude=tools .) | (cd "$STAGE/$d" && tar xf -)
done
(cd "$STAGE" && npm install --omit=dev --no-audit --no-fund >/dev/null)

# Paquete de actualización: solo el código (la app lo baja y lo usa en el siguiente arranque). No lleva el Electron.
(cd "$STAGE" && tar --owner=0 --group=0 --numeric-owner -czf "$DIST/update.tar.gz" app-main.js updater.js version.json medidores medidores-solo node_modules)

echo "==> Icono"
ICON_DIR="$ROOT/build/icon"; mkdir -p "$ICON_DIR"
node app/make-icon-pngs.js medidores/public/icon.svg "$ICON_DIR"
node app/make-icns.js "$ROOT/build/icon.icns" "$ICON_DIR"/128.png "$ICON_DIR"/256.png "$ICON_DIR"/512.png "$ICON_DIR"/1024.png

[ -d node_modules/@electron/packager ] || npm install --no-audit --no-fund >/dev/null
for ARCH in arm64 x64; do
  echo "==> Empaquetando $ARCH"
  # Electron se descarga con curl (más fiable que el descargador interno detrás de un proxy) y se guarda en build/zips.
  Z="$ROOT/build/zips/electron-v$EV-darwin-$ARCH.zip"
  [ -s "$Z" ] || curl -fsSL --retry 3 -o "$Z" "https://github.com/electron/electron/releases/download/v$EV/electron-v$EV-darwin-$ARCH.zip"
  [ -s "$ROOT/build/zips/SHASUMS256.txt" ] || curl -fsSL -o "$ROOT/build/zips/SHASUMS256.txt" "https://github.com/electron/electron/releases/download/v$EV/SHASUMS256.txt"
  npx electron-packager "$STAGE" Medidores --platform=darwin --arch=$ARCH --out="$ROOT/build/out" --overwrite --electron-zip-dir="$ROOT/build/zips" \
    --no-asar --icon="$ROOT/build/icon.icns" --app-bundle-id=com.medidores.app --app-version=0.1.0 \
    --extend-info="$ROOT/app/extend-info.plist" --darwin-dark-mode-support >/dev/null
  NAME=$([ "$ARCH" = arm64 ] && echo "Apple-Silicon" || echo "Intel")
  PKG="$ROOT/build/pkg-$ARCH/Medidores"
  mkdir -p "$PKG"
  cp -a "$ROOT/build/out/Medidores-darwin-$ARCH/Medidores.app" "$PKG/"
  cp "app/Instalar Medidores.command" "$PKG/"
  chmod +x "$PKG/Instalar Medidores.command"
  (cd "$ROOT/build/pkg-$ARCH" && zip -qry "$DIST/Medidores-$NAME.zip" Medidores)
done
ls -lh "$DIST"

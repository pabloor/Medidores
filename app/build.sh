#!/bin/bash
# Construye Medidores.app para Apple Silicon (arm64) e Intel (x64) y la versión portable de Windows (x64); deja un ZIP de cada una en dist/.
# Se puede ejecutar en Linux o macOS. Necesita Node.js y conexión a internet (descarga Electron).
# CHANNEL=pruebas construye "Medidores Pruebas": otra app (otro nombre, otro identificador y otra carpeta de datos) que se
# instala junto a la normal sin sustituirla y que solo se actualiza con las versiones de pruebas (ver updater.js).
set -euo pipefail
CHANNEL="${CHANNEL:-estable}"
if [ "$CHANNEL" = pruebas ]; then APPNAME="Medidores Pruebas"; BUNDLE=com.medidores.pruebas; ZIPNAME="Medidores-Pruebas"; PKGNAME=medidores-pruebas
else APPNAME="Medidores"; BUNDLE=com.medidores.app; ZIPNAME="Medidores"; PKGNAME=medidores-app; fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STAGE="$ROOT/build/stage"
DIST="$ROOT/dist"
rm -rf "$ROOT/build/stage" "$ROOT/build/out" "$ROOT/build/icon" "$ROOT"/build/pkg-* "$DIST"
mkdir -p "$STAGE" "$DIST" "$ROOT/build/zips"
EV=$(node -p "require('electron/package.json').version")

echo "==> Preparando el contenido de la app"
VERSION="${VERSION:-$(date -u +%Y%m%d-%H%M)}"   # orden alfabético = orden cronológico; el workflow la fija para que coincida con el tag
echo "==> Versión $VERSION ($APPNAME)"
cp app/main.js app/app-main.js app/updater.js LICENSE "$STAGE/"
# El nombre del paquete decide la carpeta de datos (~/Library/Application Support/<nombre>): la de pruebas no comparte la de la app normal
sed "s/\"name\": \"medidores-app\"/\"name\": \"$PKGNAME\"/" app/package.json > "$STAGE/package.json"
echo "{\"version\":\"$VERSION\",\"channel\":\"$CHANNEL\"}" > "$STAGE/version.json"
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
cp "$ICON_DIR/512.png" "$STAGE/icon.png"   # icono de la ventana en Windows
node app/make-icns.js "$ROOT/build/icon.icns" "$ICON_DIR"/128.png "$ICON_DIR"/256.png "$ICON_DIR"/512.png "$ICON_DIR"/1024.png

[ -d node_modules/@electron/packager ] || npm install --no-audit --no-fund >/dev/null
sed "s/<string>Medidores<\/string>/<string>$APPNAME<\/string>/" app/extend-info.plist > "$ROOT/build/extend-info.plist"
INSTALLER="Instalar $APPNAME.command"
sed "s/Medidores/$APPNAME/g" "app/Instalar Medidores.command" > "$ROOT/build/$INSTALLER"
for ARCH in arm64 x64; do
  echo "==> Empaquetando $ARCH"
  # Electron se descarga con curl (más fiable que el descargador interno detrás de un proxy) y se guarda en build/zips.
  Z="$ROOT/build/zips/electron-v$EV-darwin-$ARCH.zip"
  [ -s "$Z" ] || curl -fsSL --retry 3 -o "$Z" "https://github.com/electron/electron/releases/download/v$EV/electron-v$EV-darwin-$ARCH.zip"
  [ -s "$ROOT/build/zips/SHASUMS256.txt" ] || curl -fsSL -o "$ROOT/build/zips/SHASUMS256.txt" "https://github.com/electron/electron/releases/download/v$EV/SHASUMS256.txt"
  npx electron-packager "$STAGE" "$APPNAME" --platform=darwin --arch=$ARCH --out="$ROOT/build/out" --overwrite --electron-zip-dir="$ROOT/build/zips" \
    --no-asar --icon="$ROOT/build/icon.icns" --app-bundle-id=$BUNDLE --app-version=0.1.0 \
    --extend-info="$ROOT/build/extend-info.plist" --darwin-dark-mode-support >/dev/null
  NAME=$([ "$ARCH" = arm64 ] && echo "Apple-Silicon" || echo "Intel")
  PKG="$ROOT/build/pkg-$ARCH/$APPNAME"
  mkdir -p "$PKG"
  cp -a "$ROOT/build/out/$APPNAME-darwin-$ARCH/$APPNAME.app" "$PKG/"
  cp "$ROOT/build/$INSTALLER" "$PKG/"
  chmod +x "$PKG/$INSTALLER"
  (cd "$ROOT/build/pkg-$ARCH" && zip -qry "$DIST/$ZIPNAME-$NAME.zip" "$APPNAME")
done
# Windows x64: carpeta portable (se descomprime y se abre Medidores.exe). El icono del .exe no se puede fijar desde Linux (haría falta Wine).
echo "==> Empaquetando Windows x64"
Z="$ROOT/build/zips/electron-v$EV-win32-x64.zip"
[ -s "$Z" ] || curl -fsSL --retry 3 -o "$Z" "https://github.com/electron/electron/releases/download/v$EV/electron-v$EV-win32-x64.zip"
npx electron-packager "$STAGE" "$APPNAME" --platform=win32 --arch=x64 --out="$ROOT/build/out" --overwrite --electron-zip-dir="$ROOT/build/zips" \
  --no-asar --app-version="$VERSION" >/dev/null
PKGW="$ROOT/build/pkg-win/$APPNAME"
rm -rf "$ROOT/build/pkg-win"; mkdir -p "$PKGW"
cp -a "$ROOT/build/out/$APPNAME-win32-x64/." "$PKGW/"
sed 's/$/\r/' app/LEEME-Windows.txt > "$PKGW/LEEME.txt"   # saltos de línea de Windows (Bloc de notas)
(cd "$ROOT/build/pkg-win" && zip -qry "$DIST/$ZIPNAME-Windows-x64.zip" "$APPNAME")
ls -lh "$DIST"

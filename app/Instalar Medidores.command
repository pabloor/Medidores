#!/bin/bash
# Instala Medidores.app en Aplicaciones: la firma en local, quita el bloqueo de descarga y la abre.
cd "$(dirname "$0")"
clear
echo "Instalando Medidores…"
echo "---------------------"
if [ ! -d "Medidores.app" ]; then
  echo "No encuentro Medidores.app junto a este instalador."
  echo "Descomprime el ZIP entero y vuelve a abrirlo."
  read -n 1 -s -r -p "Pulsa una tecla para cerrar."
  exit 1
fi
# Si ya está en marcha, ciérrala.
osascript -e 'tell application "Medidores" to quit' >/dev/null 2>&1
sleep 1
DEST="/Applications/Medidores.app"
rm -rf "$DEST" 2>/dev/null || sudo rm -rf "$DEST"
if ! ditto "Medidores.app" "$DEST" 2>/dev/null; then
  echo "Hace falta tu contraseña de administrador para copiar a Aplicaciones."
  sudo ditto "Medidores.app" "$DEST" || { echo "No se pudo copiar."; read -n 1 -s -r -p "Pulsa una tecla para cerrar."; exit 1; }
fi
# Quita la marca de "descargado de internet" y firma con una firma local (ad hoc).
xattr -cr "$DEST" 2>/dev/null || sudo xattr -cr "$DEST"
if ! codesign --force --deep --sign - "$DEST" 2>/dev/null; then
  sudo codesign --force --deep --sign - "$DEST"
fi
echo ""
echo "Hecho. Medidores está en Aplicaciones."
echo "La primera vez, macOS preguntará si permites conexiones de red entrantes y el acceso a la red local: di que Sí."
open "$DEST"

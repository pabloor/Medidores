#!/bin/bash
# Lee la lista de parámetros de una mesa Yamaha (solo lectura) y la guarda en un archivo.
cd "$(dirname "$0")"
for d in /usr/local/bin /opt/homebrew/bin; do [ -x "$d/node" ] && export PATH="$d:$PATH"; done
IP=$(osascript -e 'text returned of (display dialog "IP de la mesa Yamaha:" default answer "192.168.0.2" with title "Diagnóstico Yamaha")' 2>/dev/null)
[ -z "$IP" ] && exit 0
node tools/volcar-parametros.js "$IP" && open -R parametros-*.txt
echo ""
read -n 1 -s -r -p "Pulsa una tecla para cerrar."

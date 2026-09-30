#!/bin/bash
# Lanzador de Medidores para macOS: doble clic para abrir.
cd "$(dirname "$0")"
PORT=3001
clear
echo "Medidores de la mesa (escenario, solo lectura)"
echo "-----------------------------------------------"

# ¿Está instalado Node.js?
if ! command -v node >/dev/null 2>&1; then
  for d in /usr/local/bin /opt/homebrew/bin; do [ -x "$d/node" ] && export PATH="$d:$PATH"; done
fi
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display dialog "Para usar Medidores necesitas Node.js.\n\nDescarga la versión LTS desde nodejs.org, instálala y vuelve a abrir Medidores." with title "Falta Node.js" buttons {"Cerrar", "Ir a nodejs.org"} default button 2' \
    -e 'if button returned of result is "Ir a nodejs.org" then open location "https://nodejs.org"' >/dev/null 2>&1
  exit 1
fi

# ¿Ya está abierto? Si es esta misma versión, solo abrimos el navegador.
# Si es una versión anterior (por ejemplo, tras sustituir la carpeta), se cierra y se arranca la nueva.
LOCAL=$(cat server.js drivers/*.js public/index.html public/i18n.js 2>/dev/null | shasum | cut -c1-10)
RUNNING=$(curl -s --max-time 2 "http://localhost:$PORT/version")
if [ -n "$RUNNING" ] || curl -s -o /dev/null --max-time 2 "http://localhost:$PORT"; then
  if [ "$RUNNING" = "$LOCAL" ]; then
    echo "Medidores ya estaba abierto. Abriendo el navegador…"
    open "http://localhost:$PORT"
    exit 0
  fi
  echo "Hay una versión anterior de Medidores en marcha. Cerrándola para abrir la nueva…"
  PIDS=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)
  [ -z "$PIDS" ] && PIDS=$(pgrep -f "server.js.*--port $PORT" 2>/dev/null)
  [ -n "$PIDS" ] && kill $PIDS 2>/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -o /dev/null --max-time 1 "http://localhost:$PORT" || break
    sleep 0.5
  done
fi

# Primera vez: instalar las piezas (necesita internet solo esta vez).
if [ ! -d node_modules/ws ] || [ ! -d node_modules/qrcode ]; then
  echo "Preparando Medidores por primera vez (necesita internet)…"
  if ! npm install --no-audit --no-fund; then
    osascript -e 'display dialog "No se pudieron descargar las piezas necesarias. Conéctate a internet y vuelve a abrir Medidores." with title "Medidores" buttons {"Cerrar"}' >/dev/null 2>&1
    exit 1
  fi
fi

( sleep 1.5; open "http://localhost:$PORT" ) &
echo ""
echo "Para cerrar Medidores, cierra esta ventana."
node server.js --port "$PORT"

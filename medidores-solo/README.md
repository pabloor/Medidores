# Medidores de la mesa en el móvil (solo lectura)

*Español · [English](README.en.md)*

Muestra en tiempo real los medidores de una mesa de mezclas digital en cualquier móvil conectado a la misma wifi.

**Esta es la versión de escenario (solo lectura):** no incluye ningún control de la mesa. No puede mover faders, cambiar ganancias ni apagar canales: el código de control se ha eliminado, no solo ocultado. Es adecuada para compartirla con otras personas sin riesgo para la mezcla.

## Cómo funciona

El navegador del móvil no puede hablar directamente con la mesa, así que un pequeño programa hace de puente:

    Mesa  --UDP/OSC o TCP-->  Ordenador o Raspberry Pi (server.js)  --WebSocket-->  Móvil(es)

El ordenador puente también sirve la página, así que en el móvil solo hay que abrir una dirección. Pueden conectarse varios móviles a la vez.

## Uso en Mac

1. Instala Node.js una vez: versión LTS desde https://nodejs.org.
2. Haz doble clic en **Abrir Medidores.command**. La primera vez tarda un poco más y necesita internet.
   - Si macOS dice que no puede abrirlo porque es de un desarrollador no identificado: clic derecho sobre el archivo, **Abrir**, y confirma. Solo la primera vez.
3. En la pantalla **Conectar con la mesa**, elige la marca, escribe la IP si hace falta y pulsa **Conectar**.
4. Escanea el código QR con el móvil (en la misma wifi). El QR usa la dirección wifi del Mac. Si el móvil no abre la página, la ventana del QR muestra otras direcciones del Mac para probar.

Esta versión usa el **puerto 3001**, así que puede funcionar en el mismo Mac a la vez que la versión completa (puerto 3000).

La elección de mesa se guarda en `config.json`. Para cambiarla, toca el texto de estado de arriba o ve a Ajustes → Cambiar de mesa. Para cerrar la app, cierra la ventana de la Terminal. Para actualizarla, sustituye la carpeta y vuelve a hacer doble clic en **Abrir Medidores**; los móviles se recargan solos.

Desde la Terminal (opcional):

    npm install
    node server.js                                   # abre la pantalla de conexión
    node server.js --driver yamaha --ip 192.168.1.20 # conecta directamente
    node server.js --driver sim                      # simulador

## Funciones

- **Medidores** de canales, buses, matrices y salidas principales, según la mesa. Los grupos se pueden ocultar con los botones de abajo.
- **Punto de medida de los canales** (Yamaha): Pre HPF, Pre fader o Post ON, en Ajustes. Vale para todos los móviles.
- **Retención de picos:** con la opción activada, cada medidor mantiene su pico más alto. Tocar la tira de un canal borra su pico y muestra su valor en dB; el botón de flecha circular de arriba borra todos. El borrado se aplica a la vez en todos los móviles.
- **Saturación:** el indicador rojo se enciende al llegar a 0 dB.
- **Idioma:** español, inglés, chino y ruso (Ajustes → Idioma).
- **Modo exterior:** fondo claro para leer al sol.

## Mensajes y line check (con la app de sala)

Si la versión de sala (la completa) está abierta en el mismo ordenador, esta app se enlaza con ella automáticamente:

- **Mensajes:** el botón del bocadillo, arriba, abre los mensajes. Hay mensajes rápidos ("Listo", "Cambia la pila", "Revisa el cable", "No llega señal"…) y texto libre, y se puede indicar un canal. Los mensajes que llegan se muestran en grande hasta pulsar **Visto**, y quien los envió ve que se han leído. En Android, el móvil vibra; en iPhone, Safari no lo permite. En Ajustes puedes poner tu nombre para que aparezca en tus mensajes.
- **Line check:** en Ajustes → Line check. Pulsa **Empezar** y ve dando señal a cada micro o línea: cada canal se marca solo al recibir señal clara, y los que tienen un nivel bajo y constante se marcan como posible ruido o zumbido. Sala y escenario ven el mismo line check a la vez. Tocando un canal se envía un mensaje sobre él.

El enlace solo transporta mensajes y line check: no permite ningún control de la mesa. Si la app de sala está en otro ordenador, indica su dirección en Ajustes → Dirección de la app de sala (por ejemplo, `192.168.0.34:3000`). Sin la app de sala, los medidores funcionan igual; solo faltan los mensajes y el line check.

## Mesas soportadas

| Driver | Modelos | Conexión |
|---|---|---|
| `x32` | Behringer X32, Midas M32 | UDP 10023, se detecta sola |
| `xair` | Behringer XR12/16/18, Midas MR12/18 | UDP 10024, se detecta sola |
| `yamaha` | TF, DM3, DM7, CL, QL, Rivage PM | TCP 49280, hay que dar la IP |
| `digico` | SD, Quantum, S21/S31 | UDP, hay que dar la IP (**experimental**) |

Yamaha está verificado con una DM7 Compact (V1.73). Las demás solo se han probado con emuladores. En DiGiCo, la mesa solo admite un dispositivo de tipo iPad a la vez: si el técnico usa la app oficial, esta no podrá conectarse.

## Problemas frecuentes

- **No encuentra la mesa:** comprueba que el ordenador está en la misma red que la mesa. Prueba indicando la IP.
- **No llegan medidores:** el cortafuegos del ordenador puede bloquear la conexión. En macOS, acepta cuando pregunte si node puede recibir conexiones.
- **El móvil no abre la página:** las redes de invitados suelen impedir que los dispositivos se vean entre sí. Usa la red principal.

## Probar sin mesa

- `npm run sim`: mesa simulada.
- `node tools/yamaha-falsa.js --modelo DM7` y conectar a Yamaha con IP 127.0.0.1 (también `tools/mesa-falsa.js` y `tools/digico-falsa.js`).

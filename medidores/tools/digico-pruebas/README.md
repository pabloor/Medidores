# Pruebas de medidores con una DiGiCo

Scripts usados el 27-10-2026 para investigar por qué el medidor de una DiGiCo Quantum (SD7Q-Q1) va a saltos, y lo que se averiguó. Hablan directamente con la mesa por OSC (envían al puerto 8000 y escuchan en el 9000), así que **Medidores y la app oficial de DiGiCo tienen que estar cerrados**: los tres usan el puerto 9000.

Por defecto usan la mesa `192.168.102.121`. Para otra mesa o para fijar el adaptador del Mac:

    IP=192.168.1.50 LOCAL=192.168.1.20 node tools/digico-pruebas/sondear-entradas.js 7 6 30

Si en External Control de la mesa los puertos no son Receive 8000 / Send 9000 (p. ej. porque otro dispositivo ya los usa), indícalos con `SPORT` (Receive de la mesa) y `LPORT` (Send de la mesa). Sirve para todos los scripts:

    IP=192.168.1.50 SPORT=8100 LPORT=9100 node tools/digico-pruebas/peticion-cero.js

Los que usan el driver (`probar-*.js`) reciben la IP y el adaptador como argumentos (`node … 192.168.102.121 en9 10`).

## Lo que se averiguó

- **Todos los medidores llegan en escalones de 3 dB**, redondeando hacia 0 dB. Pasa en las entradas y en las salidas, y también con la app oficial de DiGiCo: la captura de su tráfico (`captura-app-oficial-2026-10-27.txt`) muestra las mismas peticiones `/Meters/request/N ,s "<ruta>"` y los mismos `/Meters/values` con enteros, sin valores decimales (tipo `f`), a unos 20 mensajes por segundo. La mesa no ofrece por OSC una resolución mayor.
- El valor empaqueta dos números de 16 bits en −dB: pico retenido (mitad alta) y nivel (mitad baja). 126 = silencio.
- `fader_meter`, `Output/meter` y `Dynamics/input_meter` de una entrada dan la misma lectura que `post_meter`: `fader_meter` no incluye el fader.
- **`post_meter` = `pre_meter` + trim**, y el trim llega en dB con decimales (`/Input_Channels/N/Channel_Input/trim`). Si el trim no es múltiplo de 3 dB, cruzar los dos escalones acota el nivel a menos de 3 dB. Medidores lo hace por defecto; `/diagnostico?pretrim=0` lo desactiva.
- **Cuando pico y nivel llegan a 0 dB (valor 0), la mesa deja de mandar ese medidor.** Solo lo manda una vez, al pedirlo. Medidores vuelve a pedir las tiras que están arriba del todo para que no se queden clavadas a −3 dB.
- La mesa manda sus cambios de parámetros (trim, fader…) al puerto 9000 aunque nadie los pida. Para probar con `tools/digico-falsa.js` sin que interfiera una mesa real en la red, usa otro puerto: `PORT=9100 node tools/digico-falsa.js` y `--listen-port 9100` (o `LPORT=9100` en los scripts `probar-*.js`).
- La app oficial pide para los grupos `/Group_Outputs/N/Output/meter/left` y `/right`.

## Rutas de medidor que anuncia la mesa

Al consultar `/Input_Channels/N/Channel_Input/post_meter/?`, la Quantum devolvió esta lista de rutas de medidor del canal:

| Ruta (dentro de `/Input_Channels/N`) | Estado |
|---|---|
| `Channel_Input/pre_meter/left`, `/right` | La izquierda se usa (cruce con el trim) |
| `Channel_Input/post_meter/left`, `/right` | La izquierda es el medidor de entrada |
| `fader_meter/left`, `/right` | Igual que `post_meter` |
| `Output/meter/left`, `/right` | Igual que `post_meter` |
| `Dynamics/input_meter/left`, `/right` | Igual que `post_meter` |
| `EQ/GR_meter_1` … `_4` | **Sin usar.** Reducción de ganancia de la EQ dinámica; escala sin medir |
| `Dynamics/GR_meter_1` … `_4` | **Sin usar.** Reducción de ganancia de la dinámica; escala sin medir |
| `Output/meter2`, `meter4`, `meter/centre`, `SL`, `SR`, `LFE` | Sin usar (canales multicanal) |

Las rutas `GR_meter` servirían para mostrar la compresión de cada canal.

## Scripts

| Script | Qué hace |
|---|---|
| `sondear-entradas.js <canal> <grupo> <s>` | Se suscribe a ~20 rutas posibles de medidor de un canal y de un grupo, y cuenta mensajes, valores distintos y paso. Con canal 0 busca qué entradas tienen señal. |
| `combinar.js <canal> <s>` | Compara `post_meter` con `fader_meter` para ver si cruzarlos da más resolución (no la da). |
| `pre-trim.js <canal> <s>` | Registra `pre_meter`, `post_meter` y el trim, y resume los tramos con el trim quieto. Sirvió para ver que post = pre + trim. |
| `sobre-cero.js <canal> <s>` | Valores crudos de `pre_meter` y `post_meter` según el trim, y los silencios de `post_meter`. Sirvió para ver que a 0 dB la mesa deja de mandar. |
| `peticion-cero.js` | Pide tres veces `post_meter` del canal 7, `post_meter` del canal 1 y `pre_meter` del canal 7, y muestra qué contesta la mesa. También consulta `post_meter/?`, que devuelve la lista de rutas de arriba. |
| `listar-rutas.js [ruta…]` | Recorre las rutas de la mesa con consultas `/?` y guarda la lista en la carpeta temporal. Solo lee. Pendiente de usar para buscar los gangs y los canales estéreo (ver abajo). |
| `probar-digico.js <ip> [nic] [s]` | Conecta el driver y muestra los niveles de buses y matrices, con sus lados izquierdo y derecho. |
| `probar-pretrim.js <ip> <nic> <s> [falsa]` | Canal 7 con y sin el cruce `pre_meter` + trim. Con `falsa` compara con el nivel que simula `digico-falsa.js`. |
| `probar-arriba.js <ip> <nic> <s> [falsa]` | Canal 7 cerca de 0 dB con y sin volver a pedir los medidores de arriba. Con `falsa`, usa `OVER=1` en `digico-falsa.js`. |

Ejemplo con la mesa falsa:

    OVER=1 PORT=9100 node tools/digico-falsa.js &
    LPORT=9100 node tools/digico-pruebas/probar-arriba.js 127.0.0.1 "" 15 falsa

## Pendiente: pares estéreo y gangs en DiGiCo

El line check guiado comprueba pares estéreo, pero en DiGiCo hay que escribirlos a mano porque el driver aún no sabe qué canales van juntos. Hay que averiguar, con la mesa conectada:

1. **Dónde están los gangs.** En el tráfico de la app oficial no apareció ninguna ruta de gangs. `listar-rutas.js` recorre el árbol de la mesa para buscarlos: `node tools/digico-pruebas/listar-rutas.js`, después de crear en la mesa un gang de dos canales.
2. **Qué significan `/Console/Input_Channels/modes` y `/Input_Channels/N/Channel_Input/stereo_mode`.** La app oficial los consulta; con todos los canales mono valían 1. Hay que poner un canal en estéreo y ver qué cambia.
3. **El lado derecho de los canales estéreo.** En un canal estéreo de un solo número, el driver solo pide `post_meter/left`. La mesa anuncia también `post_meter/right` (en un canal mono vale 126, silencio).


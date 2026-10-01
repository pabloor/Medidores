# Medidores de la mesa en el móvil

*Español · [English](README.en.md)*

Muestra en tiempo real los medidores de una mesa de mezclas digital en cualquier móvil conectado a la misma wifi. Con mesas Yamaha también permite controlar faders, ON de canal y ganancia del previo.

## Cómo funciona

El navegador del móvil no puede hablar directamente con la mesa (usa UDP), así que un pequeño programa hace de puente:

    Mesa  --UDP/OSC o TCP-->  Ordenador o Raspberry Pi (server.js)  --WebSocket-->  Móvil(es)

El ordenador puente también sirve la página, así que en el móvil solo hay que abrir una dirección. Pueden conectarse varios móviles a la vez.

## Uso en Mac (lo normal)

1. Instala Node.js una vez: versión LTS desde https://nodejs.org.
2. Haz doble clic en **Abrir Medidores.command**. La primera vez tarda un poco más y necesita internet para descargar lo que usa la app.
   - Si macOS dice que no puede abrirlo porque es de un desarrollador no identificado: haz clic derecho sobre el archivo, elige **Abrir** y confirma. Solo hace falta la primera vez.
3. Se abre el navegador con la pantalla **Conectar con la mesa**. Elige la marca, escribe la IP si hace falta y pulsa **Conectar**.
4. Aparece un código QR: escanéalo con el móvil (en la misma wifi) para abrir la app allí.

La elección de mesa se guarda en `config.json`, así que la próxima vez conecta sola. Para cambiar de mesa, toca el texto de estado de arriba o ve a Ajustes → Cambiar de mesa. Se puede hacer desde el móvil o desde el Mac. El botón con forma de móvil (arriba, solo en el Mac) vuelve a mostrar el QR. El QR usa la dirección wifi del Mac, que es por donde llegan los móviles. En cuanto un móvil se conecta, el QR pasa a usar la dirección por la que ha llegado, que es la más fiable. Si el Mac tiene varias conexiones (wifi, cable, VPN…), la ventana del QR muestra todas sus direcciones por si hay que probar otra.

Si actualizas la app, los móviles que tengan abierta una versión anterior se recargan solos al reconectar.

Con **Retener picos** activado, cada medidor mantiene su pico más alto hasta que tocas la tira de ese canal (que también muestra su pico en dB) o pulsas el botón de flecha circular que hay junto a Medidores/Control, que borra todos los picos y saturaciones. El indicador rojo de saturación se enciende al llegar a 0 dB, igual que en la DM7 (verificado con un tono). El borrado se comparte: se aplica a la vez en todos los móviles y en el Mac. La retención de picos de la propia mesa es independiente: la DM7 no la ofrece por red, así que borrar en la mesa no borra en la app, ni al revés.

Para cerrar Medidores, cierra la ventana de la Terminal que abre el lanzador.

Al actualizar la app (sustituyendo la carpeta), basta con volver a hacer doble clic en **Abrir Medidores**: si detecta que hay una versión anterior en marcha, la cierra y arranca la nueva.

## Uso desde la Terminal (opcional)

    npm install
    node server.js                                   # abre la pantalla de conexión
    node server.js --driver yamaha --ip 192.168.1.20 # conecta directamente
    node server.js --driver sim                      # simulador
    node server.js --port 8080                       # otro puerto

## Quién puede controlar la mesa

Hay dos niveles de acceso:

- **Medición** (por defecto): quien abre la app sin clave ve los medidores, el registro, el historial, los mensajes y el line check, pero no puede mover nada en la mesa ni cambiar ajustes compartidos. No ve la pestaña Control.
- **Control**: además mueve faders, ON y ganancias, cambia de mesa y de punto de medida, configura los Shure y borra el registro y el historial.

Este mismo ordenador (la ventana de la app) siempre tiene control. Para dar control a un móvil, pulsa el botón del móvil (arriba), elige **Control** y escanea ese código: el móvil recuerda la clave. El código de **Medición** es el enlace normal, sin clave. **Generar una clave nueva** anula el código de control anterior y desconecta los móviles que lo usaban; los demás siguen midiendo.

La clave se guarda en `prefs.json` y se conserva al reiniciar, así que los códigos ya repartidos siguen valiendo. Es una protección pensada para evitar accidentes en una red local, no un sistema de seguridad: el tráfico no va cifrado. Al actualizar desde una versión sin claves, los móviles ya conectados pasan a modo medición hasta que escaneen el código de control.

## Registro del bolo y vista grande

- **Registro de saturaciones:** cada vez que un canal llega a 0 dB, se apunta con su nombre, la hora y el pico, y aparece un aviso breve en todos los móviles. Las saturaciones seguidas del mismo canal (menos de 3 segundos entre ellas) cuentan como una. El botón de la gráfica, arriba, abre el registro y muestra cuántas saturaciones no has visto todavía.
- **Historial de nivel:** en la misma ventana, una gráfica segundo a segundo, de hasta 12 horas. El Mac guarda todos los canales, así que puedes consultar cualquiera a posteriori. Con **Elegir canales** eliges cuáles ver, hasta 6 a la vez, cada uno con su color; por defecto se muestra la salida principal. Con un canal se ven su pico y su media; con varios, el pico de cada uno. Al tocar la gráfica se ven los valores de ese momento. La casilla de la lista de saturaciones permite ver solo las de los canales elegidos. Es el nivel digital de la mesa (dBFS), no el nivel de presión sonora en la sala.
- **Descargar:** el registro y el historial (de los canales elegidos) se pueden descargar como CSV. Los guarda el Mac, así que son los mismos en todos los móviles; se borran al cambiar de mesa o al cerrar la app.
- **Mover el registro:** en el ordenador, la ventana del registro es un panel flotante que se arrastra por su título y deja usar los medidores de detrás; recuerda su posición. Con **Abrir en otra ventana** se abre como ventana independiente del navegador, que puedes llevar a otra pantalla, agrandar o poner a pantalla completa. En el móvil se abre como siempre.
- **Vista grande:** en el modo Medidores, mantén pulsado un canal para verlo a pantalla completa, con su nivel en cifras grandes y su pico. Si el canal está vinculado (grupo de link o pareja estéreo de la mesa), se muestran todos los canales del grupo: apilados en vertical o en fila en horizontal. Toca para cerrar.

## Mensajes y line check (sala y escenario)

Estas dos funciones se comparten con la versión de escenario (solo lectura). Esta app hace de centro: los móviles de escenario se enlazan con ella a través del puerto 3000 del mismo ordenador. El enlace solo transporta mensajes y line check: no da acceso a los medidores de esta app ni a ningún control de la mesa.

- **Mensajes:** el botón del bocadillo, arriba, abre los mensajes. Hay mensajes rápidos ("Listo", "Cambia la pila", "Revisa el cable", "No llega señal"…), que cada móvil ve en su idioma, y texto libre, y se puede indicar un canal. Los mensajes que llegan se muestran en grande, debajo de la barra superior, hasta pulsar **Visto**; quien los envió ve quién los ha leído. En Android, el móvil vibra; en iPhone, Safari no lo permite. En Ajustes puedes poner tu nombre.
- **Line check:** en Ajustes → Line check. Pulsa **Empezar** y ve dando señal a cada micro o línea: cada canal de entrada se marca solo al recibir señal clara (por encima de −40 dB durante un instante), con su pico. Los canales con un nivel bajo (entre −80 y −45 dB) y casi constante durante 5 segundos se marcan como posible ruido o zumbido. Todos los móviles, de sala y de escenario, ven el mismo line check en directo. Al terminar, se indica qué canales no han dado señal. Tocando un canal se abre un mensaje sobre él.

## Idioma

La app está en español, inglés, chino y ruso. Cada móvil usa por defecto el idioma del teléfono (o inglés, si no es ninguno de los cuatro), y se puede cambiar en Ajustes → Idioma o en la pantalla de conexión. Las traducciones están en `public/i18n.js`.

## Mesas soportadas ahora

| Driver | Modelos | Conexión | Fiabilidad |
|---|---|---|---|
| `x32` | Behringer X32, Midas M32 | UDP 10023, se detecta sola | Protocolo bien documentado |
| `xair` | Behringer XR12/16/18, Midas MR12/18 | UDP 10024, se detecta sola | Protocolo bien documentado |
| `yamaha` | TF1/3/5, TF-Rack, DM3, DM7, CL1/3/5, QL1/5, Rivage PM | TCP 49280, hay que dar la IP | Protocolo oficial de Yamaha, detalles de la comunidad |
| `digico` | SD, Quantum, S21/S31 | UDP, hay que dar la IP | **Experimental** |

**Estado de las pruebas:** el driver de Yamaha está verificado con una mesa real (DM7 Compact, firmware V1.73): medidores, faders, ON, ganancias, links y parejas estéreo. Los demás solo se han probado con emuladores. Para comprobar el reparto de canales: Ajustes → "Mostrar valores en bruto", mete señal en un canal concreto y mira qué índice se mueve.

### Behringer / Midas

`npm start` las busca solas. Si no aparece, usa `node server.js --ip 192.168.1.20`. Si algo no cuadra, se corrige en `drivers/behringer.js` (campos `start` y `count` de cada grupo). En las XR12/XR16 el número de canales puede diferir.

### Yamaha

    node server.js --driver yamaha --ip 192.168.1.20

La IP de la mesa aparece en su pantalla de configuración de red. El driver pregunta el modelo, pide los medidores de cada grupo y muestra solo los que la mesa acepta. El número de canales sale de los datos que envía la mesa.

- **TF, DM3 y DM7:** canales, retornos, Mix, Matrix y Stereo. Por defecto, los canales se miden antes del HPF (Pre HPF) y las salidas después del fader (Post ON). El punto de medida de los canales se cambia en Ajustes → Punto de medida de los canales (Pre HPF, Pre fader o Post ON). Se guarda en `prefs.json` y vale para todos los móviles.
- **CL/QL y Rivage PM:** según la documentación de la comunidad, solo hay medidores de Mix y Matrix por este protocolo. El driver intenta pedir también los canales y, si la mesa los rechaza, los oculta.
- La DM7 usa una escala de medidores distinta. La tabla de conversión (`drivers/yamaha-dm7-meter.json`) procede del módulo yamaha-rcp de Bitfocus Companion, con licencia MIT.

### Control de la mesa (solo Yamaha)

Con una Yamaha conectada aparece arriba el selector **Medidores / Control**. En Control, cada canal tiene su medidor, la ganancia del previo, el botón ON y el fader hacia el Stereo, con una escala en dB junto al fader (de +10 a −∞, con el 0 destacado) y su valor exacto debajo. Si el fader es bajo, la escala muestra solo las marcas que caben. A la derecha quedan fijos los faders del Stereo: A y B en la DM7, uno solo en las demás.

**Capas:** abajo, en el modo Control, eliges qué ver:

- **Canales, Mix y Matrices:** en los Mix y las matrices hay fader, ON y medidor, sin ganancia porque no tienen previo. Verificado que la DM7C ofrece por red el fader y el ON de sus 48 Mix y 12 matrices.
- **Custom:** tu propia capa. Con el lápiz eliges las tiras que quieres ver, de cualquier grupo (canales, Mix, matrices o Stereo), en el orden en que las toques. Cada tira lleva arriba el color de su grupo.
- **Stereo A/B:** el botón de la derecha oculta o muestra los faders del Stereo, para ganar espacio. Si metes un Stereo en la capa Custom, aparece allí en lugar de a la derecha.

La capa elegida, la capa Custom y si se ve el Stereo se guardan en cada móvil.

Medidas de seguridad:

- **El control arranca bloqueado.** Toca el candado para desbloquearlo. Por defecto se vuelve a bloquear tras 2 minutos sin tocarlo (Ajustes → Bloqueo automático).
- **Los faders se mueven arrastrando, no tocando.** El movimiento es relativo, así que el fader nunca salta al punto donde pones el dedo. Tiene un retén en 0 dB, y al deslizar en horizontal la lista se desplaza sin mover faders.
- **Límite de fader:** por defecto, 0 dB (Ajustes → Límite de fader). Si un fader ya estaba más alto en la mesa, se puede bajar pero no subir más.
- **Ganancia a pasos de 1 dB.** Mantener pulsado + o − repite el paso.

La mesa y la app se sincronizan en ambos sentidos: lo que se toca en la mesa aparece en la app, y lo que se toca en un móvil aparece en los demás.

Qué se controla en cada modelo:

| Modelo | Fader y ON | Ganancia del previo |
|---|---|---|
| DM7 | Sí | Sí, −6 a +66 dB |
| DM3 | Sí | Sí, 0 a +64 dB |
| CL / QL / Rivage | Sí | Sí, −6 a +66 dB |
| TF | Sí | No documentada: no aparece |

Notas:

- En DM7, CL, QL y Rivage **la ganancia pertenece al puerto de entrada, no al canal.** Si ese previo lo usan otros canales, o un stagebox compartido con otra mesa (por ejemplo, la de monitores), el cambio les afecta a todos.
- Si el canal no está asignado a un previo con ganancia (por ejemplo, una entrada digital), aparece "—".
- **Canales vinculados (link y estéreo):** la app lee los grupos de link de la mesa. Si un grupo vincula la ganancia, al cambiarla en un canal se aplica el mismo cambio en dB al resto del grupo, conservando sus diferencias, como hace la mesa. El fader y el ON de los canales vinculados los propaga la propia mesa. Los vínculos se releen cada 5 segundos, así que los cambios hechos en la mesa se detectan sin reconectar. Cada tira vinculada muestra su grupo (por ejemplo, L12). Los canales emparejados en estéreo (parámetro InCh/Role de la mesa) también se respetan y llevan la etiqueta ST. Verificado con una DM7C V1.73; en otros modelos puede no estar disponible.
- La DM7 devuelve la ganancia en dB enteros en unos canales y en centésimas de dB en otros, según el previo. La app detecta la unidad de cada canal y siempre muestra dB enteros.
- De momento solo se controlan los canales de entrada mono y el Stereo. Las entradas estéreo de TF y DM3 y los Mix no están incluidos.
- El Rx Gain de Dante y la ganancia digital no están disponibles: la DM7C (V1.73) no los ofrece por su protocolo de red.
- El control está verificado con una DM7 Compact. En otros modelos, pruébalo primero con la mesa sin público.

### Receptores inalámbricos Shure

En los canales de la mesa que no tienen previo (por ejemplo, los que llegan por Dante desde un receptor inalámbrico), la app puede controlar la ganancia del propio receptor. Funciona con receptores Shure Axient Digital (AD4D, AD4Q), y el mismo comando existe en ULX-D, QLX-D y SLX-D.

1. En la app: Ajustes → Receptores Shure. Escribe la IP del receptor e indica a qué canal de la mesa va cada canal del receptor (por ejemplo, 1 → 25 y 2 → 26). Pulsa **Añadir receptor**.
   - Si una entrada del receptor llega a **varios canales de la mesa** (por ejemplo, uno para sala y otro para monitores), escríbelos separados por comas: `25, 60`. Todos muestran y cambian la misma ganancia.
   - El selector **Adaptador de red** permite elegir por qué cable o wifi del ordenador se conecta con el receptor (útil con varios adaptadores, por ejemplo uno para Dante). Con «Automático» decide el sistema. Si el adaptador elegido no está disponible, el receptor queda sin conexión en lugar de usar otro camino.
2. En esos canales, la ganancia aparece con la etiqueta **SHURE** y se ajusta con − y +, de −18 a +42 dB en pasos de 1 dB.

Detalles:

- **Solo se aplica en canales sin HA.** Si el canal tiene previo, la app muestra y controla el HA de la mesa, y no deja asignarle un receptor.
- **Sincronización:** el receptor avisa de los cambios hechos en su panel o en Wireless Workbench, así que la app siempre muestra el valor real.
- **Sin conexión:** si no hay conexión con el receptor, se muestra "—" y un punto rojo en Ajustes. La app reconecta sola.
- **Red:** el ordenador puente tiene que poder llegar a la IP del receptor. Si el receptor está en una red distinta a la del router de la mesa, conecta el Mac a las dos redes (wifi al router de la mesa y cable a la red del receptor), comprobando que las dos redes usan rangos de IP distintos.
- **Configuración:** se guarda en `shure.json` en la carpeta de la app.
- **Protocolo:** es el publicado por Shure (TCP, puerto 2202). La integración se ha probado con un emulador.

### DiGiCo (experimental)

DiGiCo no ofrece medidores en su OSC general. Este driver usa el protocolo de su app de iPad, descifrado solo en parte por la comunidad. Hay tres limitaciones importantes:

- **La mesa solo acepta un dispositivo de tipo iPad a la vez.** Si el técnico está usando la app oficial de DiGiCo en un iPad, esta app no podrá conectarse, y viceversa.
- La escala de los valores no está confirmada. Con `--digico-scale` puedes probar `linear`, `db` o `pos` (por defecto, `auto`).
- De momento solo muestra los canales de entrada.

Configuración en la mesa:

1. Setup → External Control → activa External Control.
2. Añade un dispositivo de tipo **DiGiCo Pad** con la IP del ordenador puente. Configura el envío (Send) al puerto 9000 y la recepción (Receive) al 8000.
3. Carga el conjunto de comandos de iPad en la mesa. Sin él, la mesa no responde y no da ningún error.

Arranque:

    node server.js --driver digico --ip 192.168.1.20 --sniff

Si usaste otros puertos en la mesa, añade `--send-port` y `--listen-port`. Con `--sniff`, la Terminal muestra cada mensaje nuevo que envía la mesa. Si no funciona a la primera, copia esa salida: sirve para ajustar el driver a tu modelo.

## Probar sin mesa

- `npm run sim`: mesa simulada con niveles de un concierto.
- Emuladores del protocolo de red real, para probar cada driver. Arranca uno en una terminal y el servidor en otra:
  - `node tools/mesa-falsa.js` (o `--xair`) → `node server.js --ip 127.0.0.1`
  - `node tools/yamaha-falsa.js --modelo DM7` (o `TF5`, `CL5`) → conectar a Yamaha con IP 127.0.0.1. Acepta el control y cada 6 s mueve el fader del canal 1, como si alguien lo tocara en la mesa.
  - `node tools/shure-falsa.js` → en Ajustes, añade el receptor 127.0.0.1 con canal 1 → 25 y canal 2 → 26 (la Yamaha falsa no tiene HA en esos canales). Cada 8 s cambia la ganancia del canal 2, como si alguien la tocara en el receptor.
  - `node tools/digico-falsa.js` → `node server.js --driver digico --ip 127.0.0.1`

## Problemas frecuentes

- **No encuentra la mesa:** comprueba que el ordenador puente esté en la misma red que la mesa. Prueba con `--ip`. Algunos routers bloquean los mensajes de difusión (broadcast).
- **Encuentra la mesa pero no llegan medidores:** el cortafuegos del ordenador puede bloquear UDP entrante. En Windows, permite Node.js en redes privadas.
- **El móvil no abre la página:** muchas redes de invitados tienen "aislamiento de clientes" y no dejan que los dispositivos se vean entre sí. Usa la red principal o el wifi del propio router de la mesa.
- **XR18/MR18 en modo punto de acceso:** conecta el ordenador puente y el móvil al wifi de la propia mesa.
- **La pantalla se apaga:** el bloqueo de pantalla solo se puede evitar desde la página con https; ajusta el tiempo de pantalla del móvil.

## Diagnóstico de una mesa Yamaha

**Diagnóstico Yamaha.command** (o `node tools/volcar-parametros.js IP`) pide a la mesa la lista de todos sus parámetros, los valores actuales de los vínculos y de cada parámetro de los canales de entrada, y prueba una serie de direcciones de ganancia no declaradas. Lo guarda todo en `parametros-<modelo>.txt`. Es de solo lectura y sirve para adaptar la app a un modelo nuevo o a un firmware nuevo.

## Añadir más marcas

Cada marca es un archivo en `drivers/` que emite estos eventos:

- `status` → `{ state: 'searching'|'connecting'|'connected'|'lost'|'error', detail, key, p }`. `detail` es el texto en español; `key` y `p` son el código del mensaje y sus datos, para que cada móvil lo muestre en su idioma (ver `public/i18n.js`)
- `layout` → `{ mixer: { name, model, ip }, groups: [{ id, name, strips: [{ num, name }] }] }` (el grupo con `id: 'main'` se fija a la derecha)
- `levels` → un array por grupo con los niveles en dBFS (-90 = silencio)
- `raw` → opcional, valores sin procesar para depurar

Y se registra en `drivers/index.js`.

Ya hechas: Yamaha y DiGiCo (arriba). Candidatas, según lo que se sabe de sus protocolos:

- **Behringer Wing:** protocolo propio documentado con medidores; es más complejo que el de la X32.
- **Soundcraft Ui12/16/24:** usan WebSocket; la comunidad ha descifrado el protocolo, incluidos los vúmetros.
- **PreSonus StudioLive Serie III:** protocolo UCNet descifrado por la comunidad, con medidores.
- **Allen & Heath, Midas Pro/HD96, Mackie DL:** por investigar. Sus protocolos públicos suelen estar pensados para control (faders, mutes) y en muchos casos no incluyen medidores.

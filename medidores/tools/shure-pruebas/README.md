# Pruebas con emisores de IEM Shure

Preparado el 28-10-2026 para cuando estén disponibles los emisores PSM 1000 (P10T) y Axient Digital PSM (ADTD/ADTQ). Todavía **no se ha probado con equipos reales**.

## Para qué

El line check guiado podrá comprobar los monitores: "Manda señal al Aux 3" y ✓ cuando el emisor de ese bus la recibe. Para eso hay que saber qué manda cada emisor de nivel de audio por red:

- **PSM 1000 (P10T):** según su manual, con `< SET x METER_RATE <ms> >` manda `AUDIO_IN_LVL_L` y `AUDIO_IN_LVL_R`. Falta saber la escala y si `x` es el canal del emisor.
- **Axient Digital PSM:** Shure no ha publicado sus comandos de red. Probablemente se parezcan a los de los receptores Axient Digital (`METER_RATE` y mensajes `SAMPLE`), pero hay que comprobarlo.

La interfaz ya está preparada (Ajustes → Emisores de IEM Shure y el line check de buses), pero sin comunicación con los emisores: el servidor guarda la configuración en `iem.json` y, con una mesa real, el line check muestra «sin comprobar». Con el simulador de line check (`SIM_LINECHECK=1`), el driver simula lo que recibe cada emisor (`iemInput`). Falta un driver que pida y lea el nivel de entrada de los emisores reales, con lo que salga del sondeo.

## Cómo sondearlos

1. Conecta los emisores a la misma red que el Mac y apunta sus IP (menú de red del emisor o Wireless Workbench).
2. Cierra Wireless Workbench.
3. Asigna en la mesa un auxiliar o grupo a cada canal de emisor y ten a mano tono o ruido rosa.
4. Lanza el sondeo con las IP de todos los emisores:

       node tools/shure-pruebas/sondear-emisor.js 192.168.0.60 192.168.0.61

5. Durante los 60 s, manda tono a cada bus, uno detrás de otro, unos segundos cada uno. Si es una mezcla estéreo, primero solo a la izquierda y luego a los dos lados.

Al terminar (o con Ctrl+C) imprime un resumen: cada mensaje recibido, cuántas veces, a qué ritmo y qué valores tenía cada campo. Guarda todos los mensajes con su hora en la carpeta temporal del sistema (`emisores-shure.txt`).

Opciones: `SEG=90` (duración), `RATE=200` (ms entre muestras), `CANALES=4`, `LOCAL=<IP del adaptador del Mac>`.

**Qué cambia en el emisor:** solo `METER_RATE` (cada cuánto manda la medición), y al terminar lo deja en 0, apagada, que es el valor de fábrica. No toca frecuencias, niveles, RF ni nombres. Si Wireless Workbench tenía otra frecuencia de medición, la volverá a poner al abrirse.

## Probar sin equipo

    node tools/shure-pruebas/emisor-falso.js &
    node tools/shure-pruebas/sondear-emisor.js 127.0.0.1

El emisor falso imita un P10T según su manual: el canal 1 recibe tono a ratos por los dos lados y el canal 2 solo por la izquierda. Su escala de nivel es inventada.

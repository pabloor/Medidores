# Medidores

Medidores de una mesa de mezclas digital en el móvil, por wifi.

- `medidores/`: versión de sala (completa, con control). Ver su [README](medidores/README.md).
- `medidores-solo/`: versión de escenario (solo lectura). Ver su [README](medidores-solo/README.md).
- `app/`: envoltura de Electron que empaqueta las dos como **Medidores.app** para macOS.

## Medidores.app (Mac)

Una sola app con ventana propia: lleva dentro el servidor, sin Node.js, Terminal ni navegador. Al cerrar la ventana se cierra todo.

1. Descarga el ZIP que corresponda: **Apple Silicon** (M1, M2, M3, M4) o **Intel**.
2. Descomprímelo y haz doble clic en **Instalar Medidores.command**. Copia la app a Aplicaciones, le pone una firma local, quita el bloqueo de descarga y la abre.
   - Si macOS avisa de que el instalador es de un desarrollador no identificado: clic derecho → **Abrir** → **Abrir**.
   - La primera vez, acepta las conexiones de red entrantes y el acceso a la red local.
3. Menú **Servidor → Servir también la versión de escenario** para ofrecerla a los técnicos de escenario (puerto 3001).

Los datos (mesa elegida, preferencias) se guardan en `~/Library/Application Support/medidores-app`; el menú **Servidor → Abrir carpeta de datos** la abre.

### Actualizaciones automáticas

La app se actualiza sola, sin desinstalar ni volver a instalar:

- Al abrirla (y cada hora) comprueba si hay una release más nueva en GitHub y, si la hay, descarga solo el código nuevo (unos 500 KB) en segundo plano.
- Te avisa con **Reiniciar ahora / Más tarde**. Nunca se reinicia sola, así que no se interrumpe un directo. También está en el menú **Medidores → Reiniciar para actualizar** y **Buscar actualizaciones…**.
- El código descargado se guarda en `~/Library/Application Support/medidores-app/update`, fuera de la `.app`, por lo que la firma local no se rompe.
- Si una actualización falla al arrancar, se descarta y vuelve a usarse el código instalado.

Solo cambia el código de la app (interfaz, servidores, menú), no el Electron que lleva dentro. Si algún día hace falta uno nuevo, habrá que instalar el ZIP completo otra vez; las releases lo indicarán. La primera versión con actualizaciones hay que instalarla a mano; a partir de ahí, ya no.

### Construir los ZIP

    npm install
    npm run build:mac     # deja dist/Medidores-Apple-Silicon.zip, dist/Medidores-Intel.zip y dist/update.tar.gz

Se puede ejecutar en Linux o macOS. Desde Linux no se puede firmar: por eso existe el instalador.

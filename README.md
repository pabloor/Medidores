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

### Construir los ZIP

    npm install
    npm run build:mac     # deja dist/Medidores-Apple-Silicon.zip y dist/Medidores-Intel.zip

Se puede ejecutar en Linux o macOS. Desde Linux no se puede firmar: por eso existe el instalador.

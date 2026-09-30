// Medidores.app: ventana propia + servidores integrados (sala y, opcionalmente, escenario).
// Cada servidor es el server.js de siempre, lanzado como proceso hijo con el propio Electron en modo Node.
const { app, BrowserWindow, Menu, dialog, shell, clipboard } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

const SALA = { id: 'sala', dir: 'medidores', port: 3000, label: 'Sala' };
const ESCENARIO = { id: 'escenario', dir: 'medidores-solo', port: 3001, label: 'Escenario (solo lectura)' };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { escenario: false };
const loadSettings = () => { try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch {} };
const saveSettings = () => { try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {} };

let win = null;
let quitting = false;
const running = {}; // id -> { child, port, log: [] }

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '0.0.0.0');
});
async function pickPort(preferred) {
  for (let p = preferred; p < preferred + 20; p++) if (await portFree(p)) return p;
  throw new Error('No hay ningún puerto libre cerca del ' + preferred);
}
const waitUp = (port, tries = 60) => new Promise((resolve, reject) => {
  const attempt = (n) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/version', timeout: 1000 }, (res) => { res.resume(); resolve(); });
    req.on('error', () => (n <= 0 ? reject(new Error('El servidor no ha arrancado')) : setTimeout(() => attempt(n - 1), 250)));
    req.on('timeout', () => req.destroy());
  };
  attempt(tries);
});

async function startServer(def) {
  if (running[def.id]) return running[def.id];
  const port = await pickPort(def.port);
  const dataDir = path.join(app.getPath('userData'), def.id);
  fs.mkdirSync(dataDir, { recursive: true });
  const script = path.join(__dirname, def.dir, 'server.js');
  const child = spawn(process.execPath, [script, '--port', String(port)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MEDIDORES_DATA: dataDir },
    cwd: path.join(__dirname, def.dir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entry = { child, port, log: [] };
  const keep = (b) => { entry.log.push(...b.toString().split('\n').filter(Boolean)); entry.log = entry.log.slice(-30); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code) => {
    delete running[def.id];
    if (quitting) return;
    if (def.id === 'sala') {
      dialog.showErrorBox('Medidores se ha detenido', `El servidor se cerró (código ${code}).\n\n${entry.log.slice(-8).join('\n')}`);
      app.quit();
    } else {
      settings.escenario = false; saveSettings(); buildMenu();
      dialog.showErrorBox('Servidor de escenario detenido', entry.log.slice(-8).join('\n') || `Código ${code}`);
    }
  });
  running[def.id] = entry;
  await waitUp(port);
  return entry;
}
function stopServer(def) {
  const e = running[def.id];
  if (!e) return;
  delete running[def.id];
  e.child.removeAllListeners('exit');
  e.child.kill('SIGTERM');
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1100, height: 780, minWidth: 380, minHeight: 500,
    title: 'Medidores', backgroundColor: '#111111',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(`http://localhost:${port}`);
  win.on('closed', () => { win = null; });
  // La ventana del registro ("Abrir en otra ventana") y similares: ventanas propias; enlaces externos: navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://localhost:${port}`) || url.startsWith(`http://127.0.0.1:${port}`) || url === 'about:blank' || url === '') {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#111111' } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://localhost:${port}`)) { e.preventDefault(); shell.openExternal(url); }
  });
}

async function toggleEscenario(on) {
  settings.escenario = on; saveSettings();
  if (on) {
    try {
      const e = await startServer(ESCENARIO);
      dialog.showMessageBox(win || undefined, {
        type: 'info', message: 'Versión de escenario activada',
        detail: `Los técnicos de escenario la abren desde el móvil, en la misma wifi, en el puerto ${e.port} de este Mac (por ejemplo http://<IP del Mac>:${e.port}).\n\nDesde su ventana de ajustes pueden enlazarse con esta app para los mensajes y el line check.`,
        buttons: ['Abrir en el navegador', 'Vale'], defaultId: 1,
      }).then((r) => { if (r.response === 0) shell.openExternal(`http://localhost:${e.port}`); });
    } catch (err) {
      settings.escenario = false; saveSettings();
      dialog.showErrorBox('No se pudo iniciar la versión de escenario', String(err.message || err));
    }
  } else stopServer(ESCENARIO);
  buildMenu();
}

function buildMenu() {
  const sala = running.sala;
  const esc = running.escenario;
  const template = [
    { label: 'Medidores', submenu: [
      { role: 'about', label: 'Acerca de Medidores' },
      { type: 'separator' },
      { role: 'hide', label: 'Ocultar Medidores' }, { role: 'hideOthers', label: 'Ocultar otros' }, { role: 'unhide', label: 'Mostrar todo' },
      { type: 'separator' },
      { role: 'quit', label: 'Salir de Medidores' },
    ] },
    { label: 'Edición', submenu: [
      { role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' },
      { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' },
    ] },
    { label: 'Servidor', submenu: [
      { label: sala ? `Sala: http://localhost:${sala.port}` : 'Sala: parado', enabled: false },
      { label: 'Abrir la app de sala en el navegador', enabled: !!sala, click: () => shell.openExternal(`http://localhost:${sala.port}`) },
      { label: 'Copiar dirección de sala', enabled: !!sala, click: () => clipboard.writeText(`http://localhost:${sala.port}`) },
      { type: 'separator' },
      { label: 'Servir también la versión de escenario (solo lectura)', type: 'checkbox', checked: !!esc, click: (i) => toggleEscenario(i.checked) },
      { label: esc ? `Escenario: http://localhost:${esc.port}` : 'Escenario: parado', enabled: false },
      { label: 'Abrir la versión de escenario en el navegador', enabled: !!esc, click: () => shell.openExternal(`http://localhost:${esc.port}`) },
      { type: 'separator' },
      { label: 'Abrir carpeta de datos', click: () => shell.openPath(app.getPath('userData')) },
    ] },
    { label: 'Ver', submenu: [
      { role: 'reload', label: 'Recargar' }, { type: 'separator' },
      { role: 'resetZoom', label: 'Tamaño real' }, { role: 'zoomIn', label: 'Ampliar' }, { role: 'zoomOut', label: 'Reducir' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Pantalla completa' }, { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
    ] },
    { label: 'Ventana', submenu: [{ role: 'minimize', label: 'Minimizar' }, { role: 'zoom', label: 'Zoom' }, { role: 'front', label: 'Traer todo al frente' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('before-quit', () => { quitting = true; Object.values(running).forEach((e) => e.child.kill('SIGTERM')); });
  app.on('window-all-closed', () => app.quit()); // al cerrar la ventana se cierra todo
  app.on('activate', () => { if (!win && running.sala) createWindow(running.sala.port); });

  app.whenReady().then(async () => {
    loadSettings();
    app.setName('Medidores');
    try {
      const sala = await startServer(SALA);
      buildMenu();
      createWindow(sala.port);
      if (settings.escenario) { try { await startServer(ESCENARIO); } catch { settings.escenario = false; } }
      buildMenu();
    } catch (err) {
      dialog.showErrorBox('Medidores no ha podido arrancar', String(err.message || err));
      app.quit();
    }
  });
}

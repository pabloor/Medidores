#!/usr/bin/env node
// Puente entre la mesa y el móvil (HTTP + WebSocket).
// Lo normal es arrancarlo con el lanzador (Medidores.command) y elegir la mesa desde la app.
// También acepta: node server.js [--driver auto|x32|xair|yamaha|digico|sim] [--ip 192.168.1.20] [--port 3000]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { createDriver } = require('./drivers');
const { ShureReceiver } = require('./drivers/shure');

const args = {};
process.argv.slice(2).forEach((a, i, all) => {
  if (a.startsWith('--')) args[a.slice(2)] = all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true;
});
const PORT = Number(args.port || 3000);
const PUBLIC = path.join(__dirname, 'public');
// Carpeta donde se guardan config.json, prefs.json… (la app de Mac la fija fuera de la .app; en la Terminal, junto al código)
const DATA_DIR = process.env.MEDIDORES_DATA || __dirname;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SHURE_FILE = path.join(DATA_DIR, 'shure.json');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
const METER_POINTS = ['PreHPF', 'PreFader', 'PostOn'];
let prefs = { meterPoint: 'PreHPF', controlKey: '' };
try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) }; } catch {}
// Clave de control: quien abre la app con ella (?k=...) puede mover la mesa; los demás solo ven la medición.
// Este mismo ordenador (la ventana del Mac) siempre tiene control.
const newControlKey = () => crypto.randomBytes(9).toString('base64url');
const keyWasMissing = !prefs.controlKey;
if (keyWasMissing) prefs.controlKey = newControlKey();
const isLoopback = (sock) => ['127.0.0.1', '::1'].includes(String(sock.remoteAddress || '').replace(/^::ffff:/, ''));
const sameKey = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const savePrefs = () => { try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch (e) { console.error('No se pudo guardar prefs.json:', e.message); } };
if (keyWasMissing) savePrefs(); // la clave debe sobrevivir a los reinicios: los QR ya repartidos tienen que seguir valiendo
// Huella de la versión de la app (código del servidor, drivers y página). Sirve para:
//  - que los móviles con una copia antigua de la página se recarguen solos;
//  - que el lanzador detecte si está en marcha una versión anterior y la reinicie.
// El lanzador calcula la misma huella con: cat server.js drivers/*.js public/index.html public/i18n.js | shasum
function appVersion() {
  const files = ['server.js',
    ...fs.readdirSync(path.join(__dirname, 'drivers')).filter((f) => f.endsWith('.js')).sort().map((f) => path.join('drivers', f)),
    'public/index.html', 'public/i18n.js'];
  const h = crypto.createHash('sha1');
  for (const f of files) { try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch {} }
  return h.digest('hex').slice(0, 10);
}
const APP_VERSION = appVersion();
// 'sala' = versión completa (centro de mensajes y line check). La versión de solo lectura usa 'escenario'.
const ROLE = 'sala';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

// Opciones que la app puede enviar para cada marca.
const ALLOWED = {
  auto: ['ip'], yamaha: ['ip'], digico: ['ip', 'send-port', 'listen-port', 'nic'], sim: [],
};

// Direcciones de este ordenador para abrir la app desde el móvil, de más a menos probable:
// primero la red donde está la mesa (ahí están también los móviles), luego las interfaces físicas
// (en0 suele ser la wifi del Mac) y al final las virtuales (VPN, puentes, máquinas virtuales).
function sameSubnet(ip, addr, mask) {
  const a = ip.split('.').map(Number), b = addr.split('.').map(Number), m = mask.split('.').map(Number);
  return a.length === 4 && a.every((x, i) => (x & m[i]) === (b[i] & m[i]));
}
// Interfaces wifi según macOS (en un MacBook suele ser en0). Por ahí llegan los móviles.
let wifiIfaces = new Set();
function detectWifi() {
  if (process.platform !== 'darwin') return;
  try {
    const out = execFileSync('networksetup', ['-listallhardwareports'], { timeout: 3000, encoding: 'utf8' });
    const found = new Set();
    let port = '';
    for (const line of out.split('\n')) {
      if (line.startsWith('Hardware Port:')) port = line.slice(14).trim();
      else if (line.startsWith('Device:') && /wi-?fi|airport/i.test(port)) found.add(line.slice(7).trim());
    }
    wifiIfaces = found;
  } catch {}
}
detectWifi();
setInterval(detectWifi, 60000);

// Dirección de este ordenador por la que se ha conectado de verdad un móvil (la más fiable).
let provenAddress = null;

function lanAddresses() {
  const consoleIp = state && state.config && state.config.ip;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal || a.address.startsWith('169.254.')) continue;
      const virtual = /^(utun|bridge|vmnet|vboxnet|docker|veth|llw|awdl|ppp|tun|tap|zt|anpi|vethernet|vmware|virtualbox|bluetooth|loopback)/i.test(name);
      let score = virtual ? 4 : /^(en|eth|wl)/i.test(name) ? 2 : 3;
      if (!virtual && consoleIp && net.isIPv4(consoleIp) && sameSubnet(consoleIp, a.address, a.netmask)) score = 1;
      if (wifiIfaces.has(name)) score = 0;
      if (a.address === provenAddress) score = -1;
      out.push({ name: wifiIfaces.has(name) ? `${name} · wifi` : name, address: a.address, url: `http://${a.address}:${PORT}`, score });
    }
  }
  return out.sort((x, y) => x.score - y.score || x.name.localeCompare(y.name, 'en', { numeric: true }));
}
function lanUrls() { return lanAddresses().map((a) => a.url); }

function loadConfig() {
  if (args.driver) return { driver: args.driver, ...args };
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) { console.error('No se pudo guardar config.json:', e.message); }
}

// Comprueba y limpia lo que llega desde la app.
function sanitize(input) {
  const driver = String(input.driver || '');
  if (!ALLOWED[driver]) return { error: 'Tipo de mesa no válido.', key: 'err.badDriver' };
  const cfg = { driver };
  for (const key of ALLOWED[driver]) {
    const v = String(input[key] ?? '').trim();
    if (!v) continue;
    if (key === 'ip' && !net.isIPv4(v)) return { error: `"${v}" no es una IP válida. Debe tener la forma 192.168.1.20.`, key: 'err.badIp', p: { ip: v } };
    if (key === 'nic' && !/^[A-Za-z0-9_.:-]{1,16}$/.test(v)) continue; // nombre de adaptador no válido: se ignora (automático)
    if (key.endsWith('port') && !(Number(v) >= 1 && Number(v) <= 65535)) return { error: `Puerto no válido: ${v}`, key: 'err.badPort', p: { v } };
    cfg[key] = v;
  }
  if ((driver === 'yamaha' || driver === 'digico') && !cfg.ip) return { error: 'Esta mesa necesita la IP.', key: 'err.needIp' };
  return { cfg };
}

// --- Receptores Shure: ganancia en canales de la mesa sin previo (p. ej. inalámbricos por Dante).
// shure.json: [{ "ip": "192.168.0.50", "map": { "1": 25, "2": [26, 60] } }]  (canal del receptor -> canal o canales de la mesa)
// Un canal del receptor puede llegar a varios canales de la mesa (p. ej. uno para sala y otro para monitores):
// se muestra y se cambia la misma ganancia en todos ellos.
const toList = (v) => (Array.isArray(v) ? v : [v]).map(Number);
let shureList = [];
let receivers = [];
const ext = {}; // índice de canal de la mesa -> { gain, online }
try { shureList = JSON.parse(fs.readFileSync(SHURE_FILE, 'utf8')); } catch {}

// Adaptadores de red de este ordenador (IPv4), para elegir por cuál se conecta un receptor.
// A diferencia de la lista del QR, incluye las direcciones 169.254.x.x (las que usa Dante) y las virtuales no.
function nicList() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(utun|bridge|vmnet|vboxnet|docker|veth|llw|awdl|ppp|tun|tap|zt|anpi|vethernet|vmware|virtualbox|bluetooth|loopback)/i.test(name)) continue;
    const a = (list || []).find((x) => (x.family === 'IPv4' || x.family === 4) && !x.internal);
    if (a) out.push({ name, address: a.address, wifi: wifiIfaces.has(name) });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name, 'en', { numeric: true }));
}
const nicsMsg = () => ({ type: 'nics', list: nicList() });

function sanitizeShure(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const r of list.slice(0, 16)) {
    const ip = String(r.ip || '').trim();
    if (!net.isIPv4(ip)) return null;
    const map = {};
    for (const [rx, chan] of Object.entries(r.map || {})) {
      const chans = [...new Set(toList(typeof chan === 'string' ? chan.split(/[,\s]+/).filter(Boolean) : chan))].filter((n) => Number.isInteger(n) && n >= 1 && n <= 288).slice(0, 16);
      if (!/^[1-8]$/.test(rx) || !chans.length) continue;
      map[rx] = chans.length === 1 ? chans[0] : chans; // con un solo canal se guarda como número, igual que antes
    }
    const nic = typeof r.nic === 'string' && /^[A-Za-z0-9_.:-]{1,16}$/.test(r.nic) ? r.nic : '';
    if (Object.keys(map).length) out.push({ ip, map, ...(nic ? { nic } : {}) });
  }
  return out;
}

const shureMsg = () => ({
  type: 'shure',
  list: shureList,
  online: receivers.map((r) => r.online),
  nics: nicList(),
  ext: Object.fromEntries(Object.entries(ext).map(([i, e]) => [i, e])),
});

function startShure() {
  receivers.forEach((r) => r.stop());
  for (const k of Object.keys(ext)) delete ext[k];
  receivers = shureList.map((cfg) => {
    const map = Object.fromEntries(Object.entries(cfg.map).map(([rx, chan]) => [rx, toList(chan).map((c) => c - 1)]));
    const r = new ShureReceiver(cfg.ip, map, cfg.nic);
    for (const i of Object.values(map).flat()) ext[i] = { gain: null, online: false };
    r.on('gain', ({ i, value }) => {
      ext[i] = { gain: value, online: true };
      broadcast({ type: 'param', g: 'ch', i, key: 'ext', value: ext[i] });
    });
    r.on('status', (online) => {
      for (const i of Object.values(map).flat()) {
        ext[i] = { ...ext[i], online };
        broadcast({ type: 'param', g: 'ch', i, key: 'ext', value: ext[i] });
      }
      broadcast(shureMsg());
      console.log(`[shure] ${cfg.ip} ${online ? 'conectado' : 'sin conexión'}`);
    });
    r.start();
    return r;
  });
  broadcast(shureMsg());
}

// --- Registro del bolo: saturaciones e historial del nivel de salida.
// Lo guarda el Mac para que sea igual en todos los móviles. Se reinicia al cambiar de mesa.
const CLIP_AT = 0;               // dB: igual que el indicador rojo de la app (verificado con la DM7)
const CLIP_MERGE_MS = 3000;      // saturaciones seguidas del mismo canal cuentan como una
const HISTORY_MAX = 12 * 3600;   // filas (una por segundo): 12 horas
let clipLog = [];                // { t, g, i, label, peak }
const lastClip = new Map();      // "grupo:canal" -> { ev, last }
// Historial de TODOS los canales, segundo a segundo, en un búfer circular compacto:
// décimas de dB en Int16 (-32768 = sin dato). ~170 KB por canal para 12 h.
const NO_DATA = -32768;
const hist = { times: new Int32Array(HISTORY_MAX), head: 0, len: 0, series: new Map(), acc: new Map(), labels: new Map() };
let clipTimer = null;
const r1 = (v) => Math.round(v * 10) / 10;

function stripLabel(gi, i) {
  const g = state.layout && state.layout.groups[gi];
  const s = g && g.strips[i];
  if (!s) return '';
  return s.name ? `${s.num} ${s.name}` : `${g.name} ${s.num}`;
}
function sendClipLog() {
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => broadcast({ type: 'clip-log', events: clipLog.slice(-300) }), 250);
}
function histSeries(key) {
  let sr = hist.series.get(key);
  if (!sr) {
    sr = { peak: new Int16Array(HISTORY_MAX).fill(NO_DATA), avg: new Int16Array(HISTORY_MAX).fill(NO_DATA) };
    hist.series.set(key, sr);
  }
  return sr;
}
function histAdd(key, v) {
  let a = hist.acc.get(key);
  if (!a) hist.acc.set(key, (a = { peak: -90, sum: 0, n: 0 }));
  if (v > a.peak) a.peak = v;
  a.sum += v; a.n++;
}
// Cada segundo se cierra una fila con el pico y la media de cada canal en ese segundo.
function histTick() {
  if (!hist.acc.size) return; // sin datos de la mesa: no se añaden filas vacías
  const row = hist.head;
  hist.times[row] = Math.floor(Date.now() / 1000);
  for (const key of hist.acc.keys()) histSeries(key);
  for (const [key, sr] of hist.series) {
    const a = hist.acc.get(key);
    sr.peak[row] = a && a.n ? Math.round(a.peak * 10) : NO_DATA;
    sr.avg[row] = a && a.n ? Math.round((a.sum / a.n) * 10) : NO_DATA;
  }
  hist.acc.clear();
  hist.head = (hist.head + 1) % HISTORY_MAX;
  hist.len = Math.min(hist.len + 1, HISTORY_MAX);
}
setInterval(histTick, 1000);
function histClear() { hist.head = 0; hist.len = 0; hist.acc.clear(); }
// Datos para la gráfica: como mucho "max" puntos por canal (pico = máximo, media = promedio del tramo).
function historyFor(keys, max) {
  const n = hist.len, start = (hist.head - n + HISTORY_MAX) % HISTORY_MAX;
  const step = Math.max(1, Math.ceil(n / max));
  const t = [], series = {};
  for (const key of keys) series[key] = { peak: [], avg: [] };
  for (let k = 0; k < n; k += step) {
    const end = Math.min(n, k + step);
    t.push(hist.times[(start + k) % HISTORY_MAX]);
    for (const key of keys) {
      const sr = hist.series.get(key);
      let pk = NO_DATA, sum = 0, cnt = 0;
      if (sr) for (let j = k; j < end; j++) {
        const r = (start + j) % HISTORY_MAX;
        if (sr.peak[r] !== NO_DATA) { if (sr.peak[r] > pk) pk = sr.peak[r]; sum += sr.avg[r]; cnt++; }
      }
      series[key].peak.push(cnt ? pk / 10 : null);
      series[key].avg.push(cnt ? r1(sum / cnt / 10) : null);
    }
  }
  return { t, series };
}
const validKeys = (keys) => (Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && /^(main|[a-z]{1,8}:\d{1,3})$/.test(k)).slice(0, 12);
function keyLabel(key) {
  if (key === 'main') {
    const g = state.layout && state.layout.groups.find((x) => x.id === 'main');
    return g ? g.name : 'Main';
  }
  const [gid, i] = key.split(':');
  const gi = state.layout ? state.layout.groups.findIndex((x) => x.id === gid) : -1;
  return gi >= 0 ? stripLabel(gi, Number(i)) : key;
}
function resetShowLog() {
  clipLog = []; lastClip.clear(); histClear();
}
function logLevels(levels) {
  if (!state.layout) return;
  const now = Date.now();
  levels.forEach((arr, gi) => {
    const g = state.layout.groups[gi];
    if (!g || !arr) return;
    arr.forEach((db, i) => {
      if (!(db >= CLIP_AT - 1e-6)) return;
      const key = `${g.id}:${i}`;
      const prev = lastClip.get(key);
      if (prev && now - prev.last < CLIP_MERGE_MS) {
        prev.last = now;
        if (db > prev.ev.peak) { prev.ev.peak = r1(db); sendClipLog(); }
        return;
      }
      const ev = { t: now, g: g.id, i, label: stripLabel(gi, i), peak: r1(db) };
      clipLog.push(ev);
      if (clipLog.length > 2000) clipLog.shift();
      lastClip.set(key, { ev, last: now });
      console.log(`[saturación] ${fmtTime(now)} ${ev.label} ${ev.peak} dB`);
      sendClipLog();
    });
  });
  // Historial: cada canal por separado y, además, "main" = el más alto de la salida principal.
  levels.forEach((arr, gi) => {
    const g = state.layout.groups[gi];
    if (!g || !arr) return;
    arr.forEach((db, i) => histAdd(`${g.id}:${i}`, Math.max(-90, db)));
    if (g.id === 'main' && arr.length) histAdd('main', Math.max(-90, ...arr));
  });
}
const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const fmtDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
function csv(rows) { return rows.map((r) => r.map((c) => (/[",;\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n'; }

// --- Servidor web
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/version') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end(APP_VERSION);
  }
  if (p === '/linecheck.csv') {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', // también se descarga desde la app de escenario
      'Content-Disposition': `attachment; filename="linecheck-${fmtDate(Date.now())}.csv"`,
    });
    return res.end('\ufeff' + csv(lcCsv()));
  }
  if (p === '/registro.csv' || p === '/historial.csv') {
    const rows = p === '/registro.csv'
      ? [['fecha', 'hora', 'canal', 'pico_dB'], ...clipLog.map((e) => [fmtDate(e.t), fmtTime(e.t), e.label, e.peak])]
      : (() => {
        const keys = validKeys((new URL(req.url, 'http://x').searchParams.get('c') || 'main').split(','));
        const { t, series } = historyFor(keys, Infinity);
        const head = ['fecha', 'hora'];
        for (const k of keys) head.push(`${keyLabel(k)} pico_dB`, `${keyLabel(k)} media_dB`);
        return [head, ...t.map((tt, r) => [fmtDate(tt * 1000), fmtTime(tt * 1000),
          ...keys.flatMap((k) => [series[k].peak[r] ?? '', series[k].avg[r] ?? ''])])];
      })();
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${p.slice(1, -4)}-${fmtDate(Date.now())}.csv"`,
    });
    return res.end('\ufeff' + csv(rows)); // BOM: para que Excel/Numbers lean bien los acentos
  }
  if (p === '/diagnostico') {
    if (!isLoopback(req.socket)) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    if (!driver || typeof driver.diagnostics !== 'function') return res.end('La mesa conectada no ofrece diagnóstico.');
    const q = new URL(req.url, 'http://x').searchParams;
    if ((q.get('entradas') || q.get('salidas')) && typeof driver.setMeterSource === 'function') {
      return res.end(`Origen de los medidores: ${driver.setMeterSource(q.get('entradas'), q.get('salidas'))}\n(entradas: post | fader · salidas: fader | output)`);
    }
    if (q.get('ajuste') != null && typeof driver.setChOff === 'function') {
      return res.end(`Ajuste de los medidores de entrada: -${driver.setChOff(q.get('ajuste'))} dB (por defecto 0; 0 = valor tal cual lo manda la mesa)`);
    }
    if (q.get('pretrim') != null && typeof driver.setPreTrim === 'function') {
      return res.end(`Medidor de entrada afinado con pre_meter + trim: ${driver.setPreTrim(q.get('pretrim')) ? 'activado' : 'desactivado'} (por defecto activado; ?pretrim=0 lo desactiva)`);
    }
    if (q.get('subida') != null && typeof driver.setRise === 'function') {
      return res.end(`Suavizado de la subida: ${driver.setRise(q.get('subida'))} ms (0 = sin suavizado; por defecto 0)`);
    }
    if (q.get('modo') || q.get('caida')) { // ajustes en directo del medidor (DiGiCo)
      if (typeof driver.setMeterMode === 'function') {
        if (q.get('modo')) driver.setMeterMode(q.get('modo'));
        if (q.get('caida')) driver.setFall(q.get('caida'));
        return res.end(`Ajustes del medidor: modo ${driver.meterMode}, caída ${driver.fall} dB/s\n(level = mitad baja, peak = mitad alta, max = la mayor de las dos)`);
      }
      return res.end('Esta mesa no tiene ajustes de medidor.');
    }
    if ((q.get('serie') || q.get('grupo')) && typeof driver.recordSeries === 'function') return driver.recordSeries(Number(q.get('serie')), 12000, Number(q.get('grupo')) || 0).then((txt) => res.end(txt)).catch((e) => res.end(`La grabación falló: ${e.message}`));
    if (q.get('medidor') && typeof driver.probeMeters === 'function') { // prueba de medidores sueltos (≈ 9 s)
      return driver.probeMeters(Number(q.get('medidor'))).then((txt) => res.end(txt)).catch((e) => res.end(`La prueba falló: ${e.message}`));
    }
    if (q.get('probar') && typeof driver.probe === 'function') { // prueba activa (tarda unos segundos)
      return driver.probe(Number(q.get('canal'))).then((txt) => res.end(txt + '\n' + driver.diagnostics())).catch((e) => res.end(`La prueba falló: ${e.message}`));
    }
    return res.end(driver.diagnostics());
  }
  if (p === '/qr.svg') {
    const i = Number(new URL(req.url, 'http://x').searchParams.get('i')) || 0;
    const urls = lanUrls();
    let url = urls[i] || urls[0] || `http://localhost:${PORT}`;
    if (new URL(req.url, 'http://x').searchParams.get('role') === 'control') {
      if (!isLoopback(req.socket)) { res.writeHead(403); return res.end(); }
      url = `${url.replace(/\/$/, '')}/?k=${prefs.controlKey}`;
    }
    return QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#141925', light: '#ffffff' } }).then((svg) => {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      res.end(svg);
    });
  }
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    if (file.endsWith('index.html')) data = Buffer.from(data.toString('utf8').replaceAll('__APP_VERSION__', APP_VERSION).replaceAll('__APP_ROLE__', ROLE));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store, max-age=0' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true });
const linkWss = new WebSocketServer({ noServer: true }); // enlace con la app de escenario: solo mensajes y line check
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (p === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else if (p === '/enlace' && ROLE === 'sala') linkWss.handleUpgrade(req, socket, head, (ws) => linkWss.emit('connection', ws, req));
  else socket.destroy();
});
const state = { config: null, status: { state: 'setup', detail: 'Elige tu mesa para empezar', key: 'st.setup' }, layout: null, levels: null, raw: null, control: null, meterFall: null, meterRise: null };
const q = (db) => (db <= -90 ? -90 : Math.round(db * 10) / 10); // décimas de dB: el umbral de saturación es exacto
let driver = null;
let dirty = false;

// ---------- Mensajes entre sala y escenario
const MSG_KEYS = ['msg.ready', 'msg.battery', 'msg.cable', 'msg.noSignal', 'msg.noise', 'msg.come', 'msg.wait', 'msg.ok'];
let messages = []; // { id, t, from: 'sala'|'escenario', name, key | text, ch, acks: [{ from, name }] }
let msgSeq = 0;
function linkBroadcast(obj) {
  broadcast(obj);
  const s = JSON.stringify(obj);
  for (const c of linkWss.clients) if (c.readyState === 1) c.send(s);
}
function handleShared(ws, msg) {
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  if (msg.type === 'msg-send') {
    const from = msg.from === 'escenario' ? 'escenario' : 'sala';
    const m = { id: ++msgSeq, t: Date.now(), from, name: clean(msg.name, 24), ch: clean(msg.ch, 40), cid: clean(msg.cid, 16), acks: [] };
    if (MSG_KEYS.includes(msg.key)) m.key = msg.key;
    else { m.text = clean(msg.text, 140); if (!m.text) return true; }
    messages.push(m);
    if (messages.length > 60) messages.shift();
    console.log(`[mensaje] ${fmtTime(m.t)} ${from}${m.name ? ' (' + m.name + ')' : ''}: ${m.key || m.text}${m.ch ? ' · ' + m.ch : ''}`);
    linkBroadcast({ type: 'msg', m });
    return true;
  }
  if (msg.type === 'msg-ack') {
    const m = messages.find((x) => x.id === msg.id);
    if (!m) return true;
    const ack = { from: msg.from === 'escenario' ? 'escenario' : 'sala', name: clean(msg.name, 24) };
    if (!m.acks.some((a) => a.from === ack.from && a.name === ack.name)) m.acks.push(ack);
    linkBroadcast({ type: 'msg-ack', id: m.id, acks: m.acks });
    return true;
  }
  if (/^lc-(start|stop|resume|next|prev|repeat|goto)$/.test(msg.type)) { lcCommand(msg); return true; }
  return false;
}

// ---------- Line check. Dos modos:
//   libre:  cada tira elegida se marca al recibir señal clara, en cualquier orden.
//   guiado: las tiras (o pares estéreo) van de una en una, en el orden elegido; al recibir señal la que toca, se marca y
//           se pasa a la siguiente. Avisa si la señal entra por otra tira del mismo grupo (posible cruce), si en las
//           entradas suena otra a la vez y si a un par estéreo le falta un lado.
// Las tiras pueden ser entradas, buses, matrices o salidas principales: cada una se identifica como "grupo:índice" (p. ej. "bus:2").
// En los dos modos se detecta posible ruido constante. El estado se guarda en linecheck.json (sobrevive a un reinicio),
// junto con los últimos line checks terminados, para comparar con el anterior y descargar el informe (/linecheck.csv).
const LC_HITS = 3;           // lecturas seguidas por encima del umbral: no cuenta un chasquido suelto
const LC_NOISE_MAX = -45;    // ruido: nivel bajo…
const LC_NOISE_MIN = -80;
const LC_NOISE_RANGE = 3;    // …y casi constante (variación menor de 3 dB)…
const LC_NOISE_SECONDS = 5;  // …durante 5 segundos
const LC_ADVANCE_MS = 1200;  // guiado: tiempo con el ✓ a la vista antes de pasar al siguiente
const LC_HISTORY = 10;       // line checks terminados que se guardan
// Umbrales ajustables (Ajustes del line check; los guarda prefs.json):
//   signal: dB por encima de los que hay señal · also: "también suena" a menos de estos dB del que toca
//   stereo: diferencia máxima de pico entre los lados de un par (la DiGiCo mide en escalones de 3 dB) · cross: segundos antes de avisar de un cruce
const LC_DEFAULTS = { signal: -40, also: 20, stereo: 6, cross: 1.5 };
const LC_LIMITS = { signal: [-70, -10], also: [6, 40], stereo: [1, 20], cross: [0.5, 5] };
const lcPrefs = () => ({ ...LC_DEFAULTS, ...(prefs.lc || {}) });
function setLcPrefs(v) {
  const out = lcPrefs();
  for (const [k, [mn, mx]] of Object.entries(LC_LIMITS)) { const n = Number(v && v[k]); if (Number.isFinite(n)) out[k] = Math.min(mx, Math.max(mn, Math.round(n * 10) / 10)); }
  prefs.lc = out; savePrefs();
}
const LC_FILE = path.join(DATA_DIR, 'linecheck.json');
const lc = { active: false, startedAt: 0, mode: 'guided', items: [], byKey: new Map(), steps: [], cur: -1, hot: new Map(), busy: new Set(), unarmed: new Set(), cfg: { keys: [], pairs: [], onCross: 'next' }, interrupted: false, labels: {} };
let lcLast = null;   // últimos niveles de todos los grupos (para saber qué tiras ya sonaban al empezar un paso)
let lcHistory = [];  // line checks terminados, el más reciente al final
let lcSaved = null;  // line check guardado al cerrar la app: se recupera al volver a conectar con la misma mesa
try { const f = JSON.parse(fs.readFileSync(LC_FILE, 'utf8')); lcHistory = Array.isArray(f.history) ? f.history.slice(-LC_HISTORY) : []; lcSaved = f.current || null; } catch {}

const lcMixerId = () => (state.config ? `${state.config.driver}|${state.config.ip || ''}` : '');
const lcGroups = () => (state.layout ? state.layout.groups.map((g, gi) => ({ g, gi })).filter(({ g }) => g.id !== 'vca') : []);
const lcGi = (gid) => (state.layout ? state.layout.groups.findIndex((g) => g.id === gid) : -1);
const lcSplit = (k) => { const c = String(k).lastIndexOf(':'); return [String(k).slice(0, c), Number(String(k).slice(c + 1))]; };
const lcValid = (k) => { const [gid, i] = lcSplit(k); const gi = lcGi(gid); return gi >= 0 && Number.isInteger(i) && i >= 0 && i < state.layout.groups[gi].strips.length; };
const lcLabel = (k) => { if (lc.labels[k]) return lc.labels[k]; const [gid, i] = lcSplit(k); const gi = lcGi(gid); return gi >= 0 ? stripLabel(gi, i) : k; };
const lcLevel = (k) => { const [gid, i] = lcSplit(k); const gi = lcGi(gid); const a = gi >= 0 && lcLast && lcLast[gi]; return a ? a[i] ?? -90 : -90; };
// Pares estéreo que dice la mesa (Yamaha, X32), en entradas y buses: [["ch:6", "ch:7"], …]
function lcAutoPairs() {
  const out = [];
  for (const gid of ['ch', 'bus', 'mtx']) {
    const arr = state.control && state.control[gid];
    if (!Array.isArray(arr) || lcGi(gid) < 0) continue;
    arr.forEach((c, i) => { if (c && Number.isInteger(c.pair) && c.pair > i && c.pair < arr.length) out.push([`${gid}:${i}`, `${gid}:${c.pair}`]); });
  }
  return out;
}
// Pares pedidos por la app, ya comprobados: del mismo grupo, las dos tiras elegidas y ninguna repetida.
function lcCleanPairs(pairs, keys) {
  const sel = new Set(keys), used = new Set(), out = [];
  for (const pr of Array.isArray(pairs) ? pairs.slice(0, 200) : []) {
    if (!Array.isArray(pr) || pr.length !== 2) continue;
    const [a, b] = pr.map(String);
    if (a === b || !sel.has(a) || !sel.has(b) || used.has(a) || used.has(b) || lcSplit(a)[0] !== lcSplit(b)[0]) continue;
    used.add(a); used.add(b); out.push(lcSplit(a)[1] < lcSplit(b)[1] ? [a, b] : [b, a]);
  }
  return out;
}

const lcNewStep = (keys) => ({ keys, state: 'pending', doneAt: 0, cross: null, crossAt: 0, also: new Set(), missing: null, unbalanced: false, fixed: null });
function lcStart(opts = {}) {
  if (!state.layout) return;
  // Tiras elegidas, en el orden en que llegan (es el orden del guiado). Sin elección: todas las entradas.
  let keys = Array.isArray(opts.keys) ? [...new Set(opts.keys.map(String))].filter(lcValid).slice(0, 400) : [];
  if (!keys.length) { const gi = lcGi('ch'); keys = gi >= 0 ? state.layout.groups[gi].strips.map((_, i) => `ch:${i}`) : []; }
  if (!keys.length) return;
  const pairs = lcCleanPairs(opts.pairs, keys);
  lcArchive(); // el line check anterior, si tenía algo, pasa al historial
  lc.mode = opts.mode === 'free' ? 'free' : 'guided';
  lc.cfg = { keys, pairs, onCross: opts.onCross === 'wait' ? 'wait' : 'next' }; // onCross: al detectar un cruce, pasar al siguiente (y volver al final) o esperar
  lc.active = true; lc.interrupted = false; lc.startedAt = Date.now(); lc.labels = {};
  lc.items = keys.map((k) => ({ k, ok: false, peak: -90, noise: false, level: -90, above: 0, win: [] }));
  lc.byKey = new Map(lc.items.map((it) => [it.k, it]));
  const partner = new Map(pairs.flatMap(([a, b]) => [[a, b], [b, a]]));
  const done = new Set();
  lc.steps = [];
  for (const k of keys) { // un par va en la posición de la primera de sus dos tiras
    if (done.has(k)) continue;
    const j = partner.get(k);
    const sk = j != null ? (lcSplit(k)[1] < lcSplit(j)[1] ? [k, j] : [j, k]) : [k];
    sk.forEach((x) => done.add(x));
    lc.steps.push(lcNewStep(sk));
  }
  lcGoto(lc.mode === 'guided' ? 0 : -1);
}

// Va al paso k (−1 = ninguno). El paso empieza de nuevo; conserva el aviso de cruce o de lado que falta (hasta que
// la tira suene), salvo con fresh = true (Repetir).
function lcGoto(k, fresh = false) {
  lc.cur = lc.mode === 'guided' && k >= 0 && k < lc.steps.length ? k : -1;
  const st = lc.steps[lc.cur];
  if (st) {
    Object.assign(st, lcNewStep(st.keys), fresh ? {} : { cross: st.cross, missing: st.missing, fixed: st.fixed }, { visits: (st.visits || 0) + 1 });
    for (const x of st.keys) { const it = lc.byKey.get(x); if (it) Object.assign(it, { ok: false, peak: -90, above: 0 }); }
  }
  // Las tiras que ya suenan al empezar el paso (ambiente, reproducción…) no cuentan como cruce hasta que se callen.
  // Y si la propia tira del paso ya suena al empezar (p. ej. le llega la señal cruzada de otra), no cuenta hasta que se calle:
  // solo vale la señal que empieza después de llegar al paso.
  lc.hot = new Map();
  lc.busy = new Set();
  lc.unarmed = new Set();
  const thr = lcPrefs().signal;
  if (st && lcLast) lcGroups().forEach(({ g, gi }) => (lcLast[gi] || []).forEach((db, i) => {
    const x = `${g.id}:${i}`;
    if (db >= thr) (st.keys.includes(x) ? lc.unarmed : lc.busy).add(x);
  }));
  if (lc.mode === 'guided' && lc.active && lc.cur < 0) lcFinish(); // no quedan pasos: terminado
  if (driver && typeof driver.lineCheckCue === 'function') driver.lineCheckCue(lc.active && st ? st.keys : []); // el simulador hace de técnico de escenario
  lcSend(); lcSave(true);
}
// Siguiente paso pendiente después de k (y si no hay, el primero pendiente desde el principio); −1 si no queda ninguno.
function lcNextPending(k) {
  for (let j = k + 1; j < lc.steps.length; j++) if (lc.steps[j].state === 'pending') return j;
  for (let j = 0; j <= k && j < lc.steps.length; j++) if (lc.steps[j].state === 'pending') return j;
  return -1;
}
function lcFinish() { lc.active = false; lc.cur = -1; lc.finishedAt = Date.now(); }
function lcCommand(msg) {
  if (msg.type === 'lc-start') { lcStart(msg); return; }
  if (msg.type === 'lc-stop') { if (lc.active) lcFinish(); if (driver && typeof driver.lineCheckCue === 'function') driver.lineCheckCue([]); lcSend(); lcSave(true); return; }
  if (msg.type === 'lc-resume') { // seguir un line check interrumpido (la app se cerró) o terminado antes de tiempo
    if (lc.active || !lc.steps.length) return;
    lc.active = true; lc.interrupted = false; lc.finishedAt = 0;
    if (lc.mode === 'guided') lcGoto(lcNextPending(-1)); else { lcSend(); lcSave(true); }
    return;
  }
  if (!lc.active || lc.mode !== 'guided') return;
  const st = lc.steps[lc.cur];
  if (msg.type === 'lc-next') { if (st && st.state === 'pending') st.state = 'skip'; lcGoto(lcNextPending(lc.cur)); }
  else if (msg.type === 'lc-prev') lcGoto(Math.max(0, lc.cur - 1));
  else if (msg.type === 'lc-repeat') lcGoto(lc.cur, true);
  else if (msg.type === 'lc-goto' && Number.isInteger(msg.step) && msg.step >= 0 && msg.step < lc.steps.length) lcGoto(msg.step);
}

function lcLevels(levels) {
  lcLast = levels;
  if (!lc.active || !state.layout) return;
  const now = Date.now(), guided = lc.mode === 'guided', thr = lcPrefs().signal;
  for (const { g, gi } of lcGroups()) {
    (levels[gi] || []).forEach((db, i) => {
      const k = `${g.id}:${i}`;
      if (guided) { // señal de cada tira en el paso actual, elegida o no
        const h = lc.hot.get(k) || { above: 0, since: 0, peak: -90, total: 0, t: 0 };
        if (db >= thr) {
          h.above++; if (h.above === LC_HITS) h.since = now; if (db > h.peak) h.peak = db;
          if (h.above > LC_HITS) h.total += now - h.t; // tiempo total con señal en este paso (para elegir el cruce)
        } else { h.above = 0; lc.busy.delete(k); lc.unarmed.delete(k); }
        h.t = now;
        lc.hot.set(k, h);
      }
      const it = lc.byKey.get(k);
      if (!it) return;
      it.level = db;
      if (db > it.peak) it.peak = db;
      it.above = db >= thr ? it.above + 1 : 0;
      if (!guided && it.above >= LC_HITS) it.ok = true; // en guiado se marca solo la tira que toca (ver lcGuided)
      it.win.push([now, db]);
      while (it.win.length && now - it.win[0][0] > LC_NOISE_SECONDS * 1000) it.win.shift();
      if (!it.noise && it.win.length > 20 && now - it.win[0][0] >= (LC_NOISE_SECONDS - 0.5) * 1000) {
        let mn = 0, mx = -200;
        for (const [, v] of it.win) { if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mx <= LC_NOISE_MAX && mn >= LC_NOISE_MIN && mx - mn < LC_NOISE_RANGE) it.noise = true;
      }
    });
  }
  if (guided) lcGuided(now);
  lcSave();
}

function lcGuided(now) {
  const st = lc.steps[lc.cur];
  if (!st) return;
  const P = lcPrefs(), crossMs = P.cross * 1000;
  const gid = lcSplit(st.keys[0])[0];
  const hot = (k) => { const h = lc.hot.get(k); return h && h.above >= LC_HITS && !lc.unarmed.has(k) ? h : null; };
  // Solo cuentan las tiras del mismo grupo: una entrada suena también en sus buses, y un bus en el máster.
  const others = [...lc.hot].filter(([k, h]) => h.above >= LC_HITS && !st.keys.includes(k) && !lc.busy.has(k) && lcSplit(k)[0] === gid);
  const sides = st.keys.map(hot);
  if (sides.every(Boolean)) {
    const top = Math.max(...sides.map((h) => h.peak));
    if (gid === 'ch') for (const [k, h] of others) if (h.peak >= top - P.also) st.also.add(k); // en salidas, que suenen varias es normal
    if (st.state !== 'ok') {
      if (st.cross || st.missing != null) st.fixed = { cross: st.cross, missing: st.missing }; // había un problema y ya llega bien: queda anotado
      st.state = 'ok'; st.doneAt = now; st.cross = null; st.missing = null;
      st.unbalanced = sides.length === 2 && Math.abs(sides[0].peak - sides[1].peak) > P.stereo;
      for (const k of st.keys) { const it = lc.byKey.get(k); if (it) it.ok = true; }
    }
  }
  if (st.state === 'ok') { if (now - st.doneAt >= LC_ADVANCE_MS) lcGoto(lcNextPending(lc.cur)); return; }
  // Los avisos se mantienen aunque la señal pare, hasta que el paso se dé por bueno o se repita.
  const lit = st.keys.filter((k, n) => sides[n]);
  if (lit.length) st.cross = null; // ya suena la que toca: no era un cruce
  if (st.keys.length === 2 && lit.length === 1 && now - hot(lit[0]).since >= crossMs) { st.missing = st.keys.find((k) => k !== lit[0]); if (!st.crossAt) st.crossAt = now; }
  // Posible cruce: las tiras del mismo grupo que han sonado al menos `cross` segundos mientras se esperaba la que toca,
  // de la que más tiempo ha sonado a la que menos (como mucho tres). Las que suenan un momento no cuentan.
  if (!lit.length && st.missing == null) {
    const c = [...lc.hot].filter(([k, h]) => h.total >= crossMs && !st.keys.includes(k) && !lc.busy.has(k) && lcSplit(k)[0] === gid)
      .sort((a, b) => b[1].total - a[1].total).slice(0, 3).map(([k]) => k);
    if (c.length) { if (!st.crossAt) st.crossAt = now; st.cross = c; }
  }
  // Con onCross = 'next', tras mostrar el aviso (cruce o lado que falta) un momento se pasa al siguiente; el paso queda
  // pendiente y se vuelve a él al final.
  // Solo la primera vez: al volver a él, espera (es cuando se revisa ese canal).
  if (st.crossAt && now - st.crossAt >= LC_ADVANCE_MS && lc.cfg.onCross !== 'wait' && st.visits <= 1) {
    const nx = lcNextPending(lc.cur);
    if (nx >= 0 && nx !== lc.cur) lcGoto(nx);
  }
}

// Filas del informe: una por paso (guiado) o por tira (libre)
function lcRows(src = lc) {
  const byKey = new Map(src.items.map((it) => [it.k, it]));
  const r1 = (v) => Math.round(v * 10) / 10;
  if (src.mode === 'guided' && src.steps.length) {
    const rows = src.steps.map((s) => ({
      keys: s.keys, label: s.keys.map(lcLabel).join(' + '), state: s.state,
      peak: r1(Math.max(...s.keys.map((k) => (byKey.get(k) || { peak: -90 }).peak))), peaks: s.keys.map((k) => r1((byKey.get(k) || { peak: -90 }).peak)),
      cross: (s.cross || []).map(lcLabel).join(', '), also: [...s.also].map(lcLabel), missing: s.missing != null ? lcLabel(s.missing) : '', unbalanced: s.unbalanced,
      noise: s.keys.some((k) => (byKey.get(k) || {}).noise), crossFrom: [],
      fixed: s.fixed ? { cross: (s.fixed.cross || []).map(lcLabel).join(', '), missing: s.fixed.missing != null ? lcLabel(s.fixed.missing) : '' } : null,
    }));
    // La tira por la que entró la señal de otro paso también se marca ("recibe la señal de…")
    const at = new Map(); rows.forEach((r, n) => r.keys.forEach((k) => at.set(k, n)));
    src.steps.forEach((s, n) => (s.cross || []).forEach((k) => { if (at.has(k)) rows[at.get(k)].crossFrom.push(rows[n].label); }));
    return rows;
  }
  return src.items.map((it) => ({ keys: [it.k], label: lcLabel(it.k), state: it.ok ? 'ok' : 'pending', peak: r1(it.peak), peaks: [r1(it.peak)], cross: '', also: [], missing: '', unbalanced: false, noise: it.noise, crossFrom: [], fixed: null }));
}
// Resumen de un line check para el historial y la comparación
function lcSummary() {
  return { t: lc.startedAt, end: lc.finishedAt || Date.now(), mixer: (state.layout && state.layout.mixer && state.layout.mixer.name) || '', mode: lc.mode, rows: lcRows() };
}
// Guarda en el historial el line check actual si tiene algo hecho y aún no está (al empezar otro o al cambiar de mesa)
function lcArchive() {
  if (!lc.steps.length && !lc.items.length) return;
  if (!lcRows().some((r) => r.state !== 'pending')) return;
  lcHistory = lcHistory.filter((h) => h.t !== lc.startedAt);
  lcHistory.push(lcSummary());
  lcHistory = lcHistory.slice(-LC_HISTORY);
}
// Estado actual en el archivo (cada 2 s como mucho mientras se mide; enseguida con now = true)
let lcSaveTimer = null;
function lcSave(now = false) {
  if (now) { clearTimeout(lcSaveTimer); lcSaveTimer = null; return lcWrite(); }
  if (!lcSaveTimer) lcSaveTimer = setTimeout(() => { lcSaveTimer = null; lcWrite(); }, 2000);
}
function lcWrite() {
  const labels = {}; for (const it of lc.items) labels[it.k] = lcLabel(it.k);
  const current = lc.items.length ? {
    mixer: lcMixerId(), mode: lc.mode, cfg: lc.cfg, startedAt: lc.startedAt, finishedAt: lc.finishedAt || 0, active: lc.active, cur: lc.cur, labels,
    items: lc.items.map((it) => ({ k: it.k, ok: it.ok, peak: it.peak, noise: it.noise })),
    steps: lc.steps.map((s) => ({ keys: s.keys, state: s.state, cross: s.cross, also: [...s.also], missing: s.missing, unbalanced: s.unbalanced, fixed: s.fixed })),
  } : null;
  const hist = lc.items.length && !lc.active ? [...lcHistory.filter((h) => h.t !== lc.startedAt), lcSummary()].slice(-LC_HISTORY) : lcHistory;
  try { fs.writeFileSync(LC_FILE, JSON.stringify({ current, history: hist })); } catch (e) { console.error('No se pudo guardar linecheck.json:', e.message); }
}
// Recupera el line check guardado si es de la misma mesa. Si estaba en marcha, queda como interrumpido (se puede seguir).
function lcRestore() {
  const f = lcSaved; lcSaved = null;
  if (!f || f.mixer !== lcMixerId() || !Array.isArray(f.items)) return;
  Object.assign(lc, { mode: f.mode === 'free' ? 'free' : 'guided', cfg: { keys: [], pairs: [], onCross: 'next', ...(f.cfg || {}) }, startedAt: f.startedAt || 0, finishedAt: f.finishedAt || 0,
    active: false, interrupted: !!f.active, cur: -1, labels: f.labels || {} });
  lc.items = f.items.map((it) => ({ k: it.k, ok: !!it.ok, peak: Number(it.peak) || -90, noise: !!it.noise, level: -90, above: 0, win: [] }));
  lc.byKey = new Map(lc.items.map((it) => [it.k, it]));
  lc.steps = (f.steps || []).map((s) => ({ ...lcNewStep(s.keys), state: s.state, cross: s.cross == null ? null : [].concat(s.cross), also: new Set(s.also || []), missing: s.missing, unbalanced: !!s.unbalanced, fixed: s.fixed || null }));
}

function lcPayload() {
  const st = lc.steps[lc.cur];
  // Último line check terminado distinto del actual, para comparar
  const prev = [...lcHistory].reverse().find((h) => h.t !== lc.startedAt) || null;
  return {
    type: 'lc', active: lc.active, interrupted: lc.interrupted, startedAt: lc.startedAt, finishedAt: lc.finishedAt || 0, mode: lc.mode, cur: lc.cur,
    groups: lcGroups().map(({ g }) => ({ id: g.id, name: g.name, strips: g.strips.map((s, i) => ({ k: `${g.id}:${i}`, num: s.num, label: lcLabel(`${g.id}:${i}`), named: !!s.name })) })),
    cfg: lc.cfg, autoPairs: lcAutoPairs(), prefs: lcPrefs(), limits: LC_LIMITS,
    rows: lcRows(),
    live: st ? st.keys.map((k) => Math.round(lcLevel(k) * 10) / 10) : [],
    levels: lc.active ? Object.fromEntries(lc.items.map((it) => [it.k, Math.round(it.level * 10) / 10])) : {},
    prev: prev && { t: prev.t, mixer: prev.mixer, rows: prev.rows.map((r) => ({ keys: r.keys, label: r.label, state: r.state, peak: r.peak })) },
  };
}
function lcSend() { if (state.layout) linkBroadcast(lcPayload()); }
setInterval(() => { if (lc.active) lcSend(); }, 250);

// Informe del line check en CSV: el actual o, si no hay, el último terminado
function lcCsv() {
  const src = lc.items.length ? { ...lcSummary(), rows: lcRows() } : lcHistory[lcHistory.length - 1];
  if (!src) return [['line check'], ['sin datos']];
  const st = { ok: 'con señal', skip: 'saltado', pending: 'sin señal' };
  const rows = [['line check', fmtDate(src.t), fmtTime(src.t), src.mixer, src.mode === 'guided' ? 'guiado' : 'libre'], [],
    ['paso', 'tira', 'estado', 'pico_dB', 'avisos', 'ruido']];
  src.rows.forEach((r, n) => {
    const warns = [r.cross && `la señal entra por ${r.cross}`, r.crossFrom && r.crossFrom.length && `recibe la señal de ${r.crossFrom.join(', ')}`,
      r.missing && `falta ${r.missing}`, r.unbalanced && 'lados con niveles distintos',
      r.fixed && (r.fixed.cross ? `corregido: entraba por ${r.fixed.cross}` : `corregido: faltaba ${r.fixed.missing}`),
      r.also && r.also.length && `también suena ${r.also.join(', ')}`].filter(Boolean).join('; ');
    rows.push([n + 1, r.label, st[r.state] || r.state, r.state === 'ok' ? r.peak : '', warns, r.noise ? 'posible ruido' : '']);
  });
  return rows;
}

function broadcast(obj, filter = () => true) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1 && filter(c)) c.send(msg);
}
function setStatus(s) {
  state.status = s;
  broadcast({ type: 'status', ...s });
  console.log(`[${s.state}] ${s.detail}`);
}
// JSON no admite -Infinity: se envía como null en faders ("-inf").
const encVal = (v) => (v === -Infinity ? '-inf' : v);
const enc = (c) => ({ caps: c.caps, ch: c.ch.map(encStrip), main: c.main.map(encStrip), bus: (c.bus || []).map(encStrip), mtx: (c.mtx || []).map(encStrip), vca: (c.vca || []).map(encStrip) });
const encStrip = (s) => ({ ...s, fader: encVal(s.fader) });
const meterPointMsg = () => ({ type: 'meter-point', value: prefs.meterPoint, supported: !!(driver && typeof driver.setMeterPoint === 'function') });
const CONTROL_ONLY = new Set(['set', 'connect', 'shure-set', 'meter-point', 'history-clear', 'clip-log-clear', 'lc-prefs']);
// La clave solo se le muestra al propio ordenador (para el QR de control).
const roleMsg = (ws) => ({ type: 'role', role: ws.canControl ? 'control' : 'viewer', ...(ws.local ? { key: prefs.controlKey } : {}) });
const infoMsg = () => ({ type: 'config', config: state.config, urls: lanUrls(), ifaces: lanAddresses().map((a) => a.name), version: APP_VERSION });

function startDriver(cfg) {
  if (driver) { driver.removeAllListeners(); driver.stop(); driver = null; }
  state.layout = state.levels = state.raw = state.control = state.meterFall = state.meterRise = null;
  resetShowLog();
  lcArchive(); if (lc.items.length) lcWrite(); // el line check de la mesa anterior queda en el historial
  Object.assign(lc, { active: false, interrupted: false, items: [], byKey: new Map(), steps: [], cur: -1, startedAt: 0, finishedAt: 0, labels: {} }); lcLast = null;
  broadcast({ type: 'clip-log', events: [] });
  broadcast({ type: 'history-cleared' });
  broadcast({ type: 'reset' });
  state.config = cfg;
  broadcast(infoMsg());
  broadcast(meterPointMsg());
  if (!cfg) return setStatus({ state: 'setup', detail: 'Elige tu mesa para empezar', key: 'st.setup' });
  try { driver = createDriver(cfg.driver, { ...cfg, meterPoint: prefs.meterPoint }); }
  catch (e) { return setStatus({ state: 'error', detail: e.message, key: 'st.driverError', p: { msg: e.message } }); }
  broadcast(meterPointMsg());
  driver.on('status', setStatus);
  driver.on('layout', (l) => { state.layout = l; broadcast({ type: 'layout', ...l }); if (ROLE === 'sala') { if (lcSaved) lcRestore(); lcSend(); } }); // nombres para elegir en el line check; recupera el guardado
  driver.on('levels', (g) => { state.levels = g; dirty = true; if (ROLE === 'sala') { logLevels(g); lcLevels(g); } });
  driver.on('raw', (r) => { state.raw = r; });
  driver.on('meterPoint', (v) => { prefs.meterPoint = v; broadcast(meterPointMsg()); });
  // Control (solo drivers que lo admiten): estado completo y cambios sueltos.
  if (driver.rise != null) state.meterRise = driver.rise; // suavizado de la subida: solo lo pide DiGiCo
  driver.on('meterRise', (v) => { state.meterRise = v; broadcast({ type: 'meter-rise', value: v }); });
  driver.on('meterFall', (v) => { state.meterFall = v; broadcast({ type: 'meter-fall', value: v }); }); // caída del medidor ajustada desde el diagnóstico
  driver.on('control', (c) => { state.control = c; broadcast({ type: 'control', ...enc(c) }); });
  driver.on('param', (p) => {
    const c = state.control && state.control[p.g] && state.control[p.g][p.i];
    if (c) c[p.key] = p.value;
    broadcast({ type: 'param', ...p, value: encVal(p.value) }, (ws) => ws !== p.origin);
  });
  driver.start();
}

linkWss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'msgs', list: messages.slice(-30) }));
  ws.send(JSON.stringify(lcPayload()));
  ws.on('message', (m) => {
    let msg;
    try { msg = JSON.parse(m); } catch { return; }
    handleShared(ws, msg); // cualquier otra cosa se ignora
  });
});

wss.on('connection', (ws, req) => {
  // Si se conecta un móvil (no este mismo ordenador), apuntamos por qué dirección ha llegado.
  const localAddr = String(req.socket.localAddress || '').replace(/^::ffff:/, '');
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (net.isIPv4(localAddr) && !localAddr.startsWith('127.') && remote !== localAddr && localAddr !== provenAddress) {
    provenAddress = localAddr;
    setImmediate(() => broadcast(infoMsg()));
  }
  const local = isLoopback(req.socket);
  ws.local = local;
  ws.canControl = local || sameKey(new URL(req.url, 'http://x').searchParams.get('k'), prefs.controlKey);
  ws.send(JSON.stringify(roleMsg(ws)));
  ws.send(JSON.stringify(infoMsg()));
  ws.send(JSON.stringify({ type: 'status', ...state.status }));
  if (state.layout) ws.send(JSON.stringify({ type: 'layout', ...state.layout }));
  if (state.control) ws.send(JSON.stringify({ type: 'control', ...enc(state.control) }));
  if (state.meterFall) ws.send(JSON.stringify({ type: 'meter-fall', value: state.meterFall }));
  if (state.meterRise != null) ws.send(JSON.stringify({ type: 'meter-rise', value: state.meterRise }));
  ws.send(JSON.stringify(shureMsg()));
  ws.send(JSON.stringify(meterPointMsg()));
  ws.send(JSON.stringify({ type: 'clip-log', events: clipLog.slice(-300) }));
  if (ROLE === 'sala') {
    ws.send(JSON.stringify({ type: 'msgs', list: messages.slice(-30) }));
    ws.send(JSON.stringify(lcPayload()));
  }
  ws.on('message', (m) => {
    let msg;
    try { msg = JSON.parse(m); } catch { return; }
    if (msg.type === 'raw') ws.wantsRaw = !!msg.on;
    if (msg.type === 'nics') return ws.send(JSON.stringify(nicsMsg()));
    if (ROLE === 'sala' && handleShared(ws, msg)) return;
    // Quien no tiene la clave solo puede medir: nada de lo que modifica la mesa o los ajustes compartidos.
    if (!ws.canControl && CONTROL_ONLY.has(msg.type)) return;
    if (msg.type === 'control-key-regen' && ws.local) {
      prefs.controlKey = newControlKey(); savePrefs();
      for (const c of wss.clients) if (!c.local) { c.canControl = false; c.send(JSON.stringify(roleMsg(c))); c.close(); }
      return ws.send(JSON.stringify(roleMsg(ws)));
    }
    if (msg.type === 'lc-prefs') { setLcPrefs(msg.prefs); return lcSend(); } // umbrales del line check (ajuste compartido: solo con control)
    if (msg.type === 'history-get') {
      const keys = validKeys(msg.keys);
      return ws.send(JSON.stringify({ type: 'history', keys, ...historyFor(keys, 1200) }));
    }
    if (msg.type === 'clip-log-clear') {
      clipLog = []; lastClip.clear();
      return broadcast({ type: 'clip-log', events: [] });
    }
    if (msg.type === 'history-clear') {
      histClear();
      return broadcast({ type: 'history-cleared' });
    }
    if (msg.type === 'clear-peaks') {
      // Un móvil ha borrado picos: se reenvía a los demás (todo, o un canal concreto).
      const out = { type: 'clear-peaks' };
      if (typeof msg.g === 'string' && Number.isInteger(msg.i)) { out.g = msg.g.slice(0, 16); out.i = msg.i; }
      return broadcast(out, (other) => other !== ws);
    }
    if (msg.type === 'meter-point') {
      if (!METER_POINTS.includes(msg.value)) return;
      prefs.meterPoint = msg.value;
      savePrefs();
      if (driver && typeof driver.setMeterPoint === 'function') driver.setMeterPoint(msg.value);
      return broadcast(meterPointMsg());
    }
    if (msg.type === 'shure-set') {
      const list = sanitizeShure(msg.list);
      if (!list) return ws.send(JSON.stringify({ type: 'shure-error', error: 'Revisa la IP del receptor.', key: 'err.shureIp' }));
      shureList = list;
      try { fs.writeFileSync(SHURE_FILE, JSON.stringify(list, null, 2)); } catch (e) { console.error('No se pudo guardar shure.json:', e.message); }
      return startShure();
    }
    if (msg.type === 'set' && msg.key === 'ext') {
      const i = msg.i;
      if (msg.g !== 'ch' || !Number.isInteger(i) || !Number.isFinite(msg.value)) return;
      // Solo en canales sin ganancia HA.
      if (state.control && state.control.ch[i] && state.control.ch[i].gain != null) return;
      const r = receivers.find((x) => Object.values(x.map).some((l) => l.includes(i)));
      const value = r && r.setGain(i, msg.value);
      if (value === undefined || !ext[i]) return;
      // La misma entrada del receptor puede llegar a varios canales de la mesa: todos muestran el valor nuevo.
      for (const j of r.linked(i)) {
        if (!ext[j]) continue;
        ext[j] = { ...ext[j], gain: value };
        broadcast({ type: 'param', g: 'ch', i: j, key: 'ext', value: ext[j] }, j === i ? (other) => other !== ws : undefined);
      }
      return;
    }
    if (msg.type === 'set' && driver && typeof driver.set === 'function' && state.control) {
      const { g, i, key } = msg;
      if (!['ch', 'main', 'bus', 'mtx', 'vca'].includes(g) || !Number.isInteger(i) || !['fader', 'on', 'gain'].includes(key)) return;
      if (key === 'gain' && g !== 'ch') return; // Mix, Matrices y Stereo no tienen previo
      let value = msg.value === '-inf' ? -Infinity : msg.value;
      if (key === 'on') value = !!value;
      else if (!(value === -Infinity || Number.isFinite(value))) return;
      value = driver.set(g, i, key, value);
      if (value === undefined) return;
      // Los demás móviles se enteran enseguida; la mesa lo confirma después.
      const c = state.control[g] && state.control[g][i];
      if (c) { c[key] = value; broadcast({ type: 'param', g, i, key, value: encVal(value) }, (other) => other !== ws); }
    }
    if (msg.type === 'connect') {
      const { cfg, error } = sanitize(msg);
      if (error) return ws.send(JSON.stringify({ type: 'connect-error', error, key: sanitize(msg).key, p: sanitize(msg).p }));
      saveConfig(cfg);
      startDriver(cfg);
    }
  });
});

setInterval(() => {
  if (!dirty || !state.levels) return;
  dirty = false;
  broadcast({ type: 'meters', g: state.levels.map((a) => a.map(q)) });
}, 60);
setInterval(() => { if (state.raw) broadcast({ type: 'raw', raw: state.raw }, (c) => c.wantsRaw); }, 500);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\nEl puerto ${PORT} ya está en uso: probablemente Medidores ya está abierto. Ciérralo o usa --port 3001.\n`);
  else console.error(e.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nMedidores en marcha. No cierres esta ventana mientras lo uses.');
  console.log(`En este ordenador: http://localhost:${PORT}`);
  lanUrls().forEach((u) => console.log(`En el móvil (misma wifi): ${u}`));
  console.log('');
  startDriver(loadConfig());
  startShure();
});

const quit = () => { if (driver) driver.stop(); receivers.forEach((r) => r.stop()); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);

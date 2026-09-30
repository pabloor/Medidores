#!/usr/bin/env node
// Puente entre la mesa y el móvil (HTTP + WebSocket). VERSIÓN ESCENARIO (solo lectura): sin control de la mesa.
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

const args = {};
process.argv.slice(2).forEach((a, i, all) => {
  if (a.startsWith('--')) args[a.slice(2)] = all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true;
});
const PORT = Number(args.port || 3001); // 3001: puede funcionar a la vez que la versión de sala (3000)
const PUBLIC = path.join(__dirname, 'public');
// Carpeta donde se guardan config.json, prefs.json… (la app de Mac la fija fuera de la .app; en la Terminal, junto al código)
const DATA_DIR = process.env.MEDIDORES_DATA || __dirname;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
const METER_POINTS = ['PreHPF', 'PreFader', 'PostOn'];
let prefs = { meterPoint: 'PreHPF' };
try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) }; } catch {}
const savePrefs = () => { try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch (e) { console.error('No se pudo guardar prefs.json:', e.message); } };
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
const ROLE = 'escenario';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

// Opciones que la app puede enviar para cada marca.
const ALLOWED = {
  auto: ['ip'], yamaha: ['ip'], digico: ['ip', 'send-port', 'listen-port'], sim: [],
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
      const virtual = /^(utun|bridge|vmnet|vboxnet|docker|veth|llw|awdl|ppp|tun|tap|zt|anpi)/i.test(name);
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
    if (key.endsWith('port') && !(Number(v) >= 1 && Number(v) <= 65535)) return { error: `Puerto no válido: ${v}`, key: 'err.badPort', p: { v } };
    cfg[key] = v;
  }
  if ((driver === 'yamaha' || driver === 'digico') && !cfg.ip) return { error: 'Esta mesa necesita la IP.', key: 'err.needIp' };
  return { cfg };
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
  if (p === '/qr.svg') {
    const i = Number(new URL(req.url, 'http://x').searchParams.get('i')) || 0;
    const urls = lanUrls();
    const url = urls[i] || urls[0] || `http://localhost:${PORT}`;
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
const state = { config: null, status: { state: 'setup', detail: 'Elige tu mesa para empezar', key: 'st.setup' }, layout: null, levels: null, raw: null, control: null };
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
  if (msg.type === 'lc-start') { lcStart(); return true; }
  if (msg.type === 'lc-stop') { lc.active = false; lcSend(); return true; }
  return false;
}

// ---------- Line check: cada canal de entrada se marca al recibir señal clara; detecta posible ruido constante
const LC_SIGNAL = -40;       // dB: por encima, el canal tiene señal
const LC_NOISE_MAX = -45;    // ruido: nivel bajo…
const LC_NOISE_MIN = -80;
const LC_NOISE_RANGE = 3;    // …y casi constante (variación menor de 3 dB)…
const LC_NOISE_SECONDS = 5;  // …durante 5 segundos
const lc = { active: false, startedAt: 0, items: [] };
function lcStart() {
  const gi = state.layout ? state.layout.groups.findIndex((g) => g.id === 'ch') : -1;
  const n = gi >= 0 ? state.layout.groups[gi].strips.length : 0;
  lc.active = true; lc.startedAt = Date.now();
  lc.items = Array.from({ length: n }, (_, i) => ({ i, ok: false, peak: -90, noise: false, level: -90, above: 0, win: [] }));
  lcSend();
}
function lcLevels(levels) {
  if (!lc.active || !state.layout) return;
  const gi = state.layout.groups.findIndex((g) => g.id === 'ch');
  const arr = gi >= 0 && levels[gi];
  if (!arr) return;
  const now = Date.now();
  arr.forEach((db, i) => {
    const it = lc.items[i];
    if (!it) return;
    it.level = db;
    if (db > it.peak) it.peak = db;
    it.above = db >= LC_SIGNAL ? it.above + 1 : 0;
    if (it.above >= 3) it.ok = true; // 3 lecturas seguidas: no cuenta un chasquido suelto
    it.win.push([now, db]);
    while (it.win.length && now - it.win[0][0] > LC_NOISE_SECONDS * 1000) it.win.shift();
    if (!it.noise && it.win.length > 20 && now - it.win[0][0] >= (LC_NOISE_SECONDS - 0.5) * 1000) {
      let mn = 0, mx = -200;
      for (const [, v] of it.win) { if (v < mn) mn = v; if (v > mx) mx = v; }
      if (mx <= LC_NOISE_MAX && mn >= LC_NOISE_MIN && mx - mn < LC_NOISE_RANGE) it.noise = true;
    }
  });
}
function lcPayload() {
  const gi = state.layout ? state.layout.groups.findIndex((g) => g.id === 'ch') : -1;
  return {
    type: 'lc', active: lc.active, startedAt: lc.startedAt,
    items: lc.items.map((it) => ({ i: it.i, label: gi >= 0 ? stripLabel(gi, it.i) : String(it.i + 1), ok: it.ok, noise: it.noise,
      peak: Math.round(it.peak * 10) / 10, level: Math.round(it.level * 10) / 10 })),
  };
}
function lcSend() { linkBroadcast(lcPayload()); }
setInterval(() => { if (lc.active) lcSend(); }, 250);

function broadcast(obj, filter = () => true) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1 && filter(c)) c.send(msg);
}
function setStatus(s) {
  state.status = s;
  broadcast({ type: 'status', ...s });
  console.log(`[${s.state}] ${s.detail}`);
}
const meterPointMsg = () => ({ type: 'meter-point', value: prefs.meterPoint, supported: !!(driver && typeof driver.setMeterPoint === 'function') });
const infoMsg = () => ({ type: 'config', config: state.config, urls: lanUrls(), ifaces: lanAddresses().map((a) => a.name), version: APP_VERSION });

function startDriver(cfg) {
  if (driver) { driver.removeAllListeners(); driver.stop(); driver = null; }
  state.layout = state.levels = state.raw = state.control = null;
  resetShowLog();
  lc.active = false; lc.items = [];
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
  driver.on('layout', (l) => { state.layout = l; broadcast({ type: 'layout', ...l }); });
  driver.on('levels', (g) => { state.levels = g; dirty = true; if (ROLE === 'sala') { logLevels(g); lcLevels(g); } });
  driver.on('raw', (r) => { state.raw = r; });
  driver.on('meterPoint', (v) => { prefs.meterPoint = v; broadcast(meterPointMsg()); });
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
  const local = String(req.socket.localAddress || '').replace(/^::ffff:/, '');
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (net.isIPv4(local) && !local.startsWith('127.') && remote !== local && local !== provenAddress) {
    provenAddress = local;
    setImmediate(() => broadcast(infoMsg()));
  }
  ws.send(JSON.stringify(infoMsg()));
  ws.send(JSON.stringify({ type: 'status', ...state.status }));
  if (state.layout) ws.send(JSON.stringify({ type: 'layout', ...state.layout }));
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
    if (ROLE === 'sala' && handleShared(ws, msg)) return;
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
    // Versión solo lectura: cualquier orden de control ('set', 'shure-set'…) se ignora.
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
});

const quit = () => { if (driver) driver.stop(); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);

// Control de una Behringer X32 / Midas M32 por OSC: fader, ON y ganancia del previo de canales, buses, matrices y Main.
// Los mapas salen de la documentación no oficial del protocolo (Patrick-Gilles Maillot); compruébalos con tu mesa.
//   Fader   /ch/01/mix/fader   float 0..1 (0.75 = 0 dB, 1 = +10 dB, 0 = -inf)
//   ON      /ch/01/mix/on      int 0/1
//   Previo  /headamp/000/gain  float 0..1 = -12..+60 dB (el previo que usa cada canal depende de su fuente y del enrutado)
//   Cambios de la mesa: se reciben mientras se renueve /xremote cada < 10 s.
const osc = require('./osc');

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');

// Fader: curva de cuatro tramos de la X32.
const faderToDb = (f) => (f >= 0.5 ? f * 40 - 30 : f >= 0.25 ? f * 80 - 50 : f >= 0.0625 ? f * 160 - 70 : f * 480 - 90);
const dbToFader = (db) => (db <= -90 ? 0 : db >= 10 ? 1 : db >= -10 ? (db + 30) / 40 : db >= -30 ? (db + 50) / 80 : db >= -60 ? (db + 70) / 160 : (db + 90) / 480);
const quant = (f) => Math.round(f * 1023) / 1023;               // el fader de la X32 tiene 1024 pasos
const toDbOut = (f) => (f <= 0 ? -Infinity : Math.round(faderToDb(f) * 10) / 10);

const GAIN_MIN = -12, GAIN_MAX = 60;
const gainToF = (db) => (db - GAIN_MIN) / (GAIN_MAX - GAIN_MIN);
const fToGain = (f) => Math.round(GAIN_MIN + f * (GAIN_MAX - GAIN_MIN));

const GROUPS = { ch: { n: 32, path: (i) => `/ch/${pad2(i + 1)}` }, bus: { n: 16, path: (i) => `/bus/${pad2(i + 1)}` }, mtx: { n: 6, path: (i) => `/mtx/${pad2(i + 1)}` }, main: { n: 1, path: () => '/main/st' } };
const LINK_PATH = { ch: (k) => `/config/chlink/${2 * k + 1}-${2 * k + 2}`, bus: (k) => `/config/buslink/${2 * k + 1}-${2 * k + 2}`, mtx: (k) => `/config/mtxlink/${2 * k + 1}-${2 * k + 2}` };
const ROUTE_PATH = (b) => `/config/routing/IN/${8 * b + 1}-${8 * b + 8}`;

// Previo (headamp 0..127) al que llega cada fuente del canal. Locales 0..31, AES50-A 32..79, AES50-B 80..127.
// La fuente del canal (insrc, 0..64) es: 0 OFF, 1-32 entradas In01-32, 33-38 Aux, 39-40 USB, 41-48 efectos, 49-64 buses.
// Solo las entradas In01-32 tienen previo; a qué previo físico llegan (local, AES50-A o B) lo decide el enrutado de entradas.
function headampOf(src, route) {
  if (src >= 1 && src <= 32) {
    const b = Math.floor((src - 1) / 8), k = (src - 1) % 8;
    const e = route[b] ?? b; // sin dato del enrutado se asume el de fábrica (In 1-8 = entradas locales 1-8…)
    if (e >= 0 && e <= 3) return e * 8 + k;               // AN1-8 … AN25-32 (entradas locales)
    if (e >= 4 && e <= 9) return 32 + (e - 4) * 8 + k;    // A1-8 … A41-48
    if (e >= 10 && e <= 15) return 80 + (e - 10) * 8 + k; // B1-8 … B41-48
    return null;                                           // tarjeta, USB…: sin previo en la mesa
  }
  return null;
}

class X32Control {
  constructor(driver) {
    this.d = driver;
    const mk = (n) => Array.from({ length: n }, () => ({ fader: null, on: null, gain: null, link: 0, stereo: false, pair: -1 }));
    this.cs = { ch: mk(32), bus: mk(16), mtx: mk(6), main: mk(1) };
    this.src = Array(32).fill(null);       // fuente de cada canal
    this.route = [null, null, null, null]; // enrutado de las entradas 1-8, 9-16…
    this.hamp = {};                        // headamp -> dB
    this.hampOf = Array(32).fill(null);    // headamp de cada canal
    this.ready = false;
    this.rx = { fader: 0, on: 0, insrc: 0, route: 0, headamp: 0, link: 0 }; // respuestas recibidas
    this.raw = {};                                                       // últimas respuestas de las lecturas de ganancia
    this.queue = [];
    this.pend = new Map();
    this.timers = [];
  }

  tx(addr, args = []) { this.d.send(addr, args, this.d.profile.port, this.d.ip); }

  start() {
    // Peticiones espaciadas: la mesa pierde paquetes si se le manda todo de golpe.
    this.timers.push(setInterval(() => { const a = this.queue.shift(); if (a) this.tx(a); }, 3));
    this.timers.push(setInterval(() => this.tx('/xremote'), 8000)); // pide que la mesa avise de sus cambios
    this.tx('/xremote');
    for (let b = 0; b < 4; b++) this.ask(ROUTE_PATH(b));
    for (const [g, def] of Object.entries(GROUPS)) {
      for (let i = 0; i < def.n; i++) { this.ask(`${def.path(i)}/mix/fader`); this.ask(`${def.path(i)}/mix/on`); }
    }
    for (let i = 0; i < 32; i++) this.ask(`${GROUPS.ch.path(i)}/config/insrc`);
    for (const g of ['ch', 'bus', 'mtx']) for (let k = 0; k < GROUPS[g].n / 2; k++) this.ask(LINK_PATH[g](k));
    // Si la mesa no ha contestado a todo, se publica lo que haya: lo demás llega después como cambios sueltos.
    this.timers.push(setTimeout(() => this.publish(), 2500));
    this.timers.push(setInterval(() => this.retryMissing(), 4000));
    // Relectura completa de faders y ON: recupera paquetes perdidos.
    this.timers.push(setInterval(() => {
      for (const def of Object.values(GROUPS)) for (let i = 0; i < def.n; i++) { this.ask(`${def.path(i)}/mix/fader`); this.ask(`${def.path(i)}/mix/on`); }
    }, 20000));
  }

  ask(addr) { this.queue.push(addr); }

  stop() { this.timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); clearTimeout(this.flushTimer); }

  encode() {
    const map = (arr) => arr.map((c) => ({ fader: c.fader, on: c.on, gain: c.gain, link: 0, stereo: c.stereo, pair: c.pair }));
    return {
      caps: { gain: { min: GAIN_MIN, max: GAIN_MAX, step: 1 }, faderMax: 10, mainNames: ['Stereo'] },
      ch: map(this.cs.ch), main: map(this.cs.main), bus: map(this.cs.bus), mtx: map(this.cs.mtx),
    };
  }
  publish() { this.ready = true; this.d.emit('control', this.encode()); }

  setVal(g, i, key, v) {
    const c = this.cs[g][i];
    if (!c || c[key] === v) return;
    c[key] = v;
    if (this.ready) this.d.emit('param', { g, i, key, value: v });
  }

  // Recalcula el previo de cada canal (según su fuente y el enrutado) y pide el valor de los que falten.
  refreshHamp() {
    for (let i = 0; i < 32; i++) {
      if (this.src[i] == null) continue;
      const h = headampOf(this.src[i], this.route);
      this.hampOf[i] = h;
      if (h != null && !(h in this.hamp)) { this.hamp[h] = null; this.ask(`/headamp/${pad3(h)}/gain`); }
      this.setVal('ch', i, 'gain', h != null && this.hamp[h] != null ? this.hamp[h] : null);
    }
  }

  setLinks(g) {
    const arr = this.cs[g];
    arr.forEach((c, i) => {
      const k = Math.floor(i / 2), linked = this.linkState && this.linkState[g][k];
      this.setVal(g, i, 'stereo', !!linked);
      this.setVal(g, i, 'pair', linked ? i ^ 1 : -1);
    });
  }

  keep(m) { if (Object.keys(this.raw).length < 60) this.raw[m.address] = JSON.stringify(m.args); }

  // Las lecturas se pierden a veces (UDP): se repiten las que aún no han recibido respuesta.
  retryMissing() {
    for (let i = 0; i < 32; i++) if (this.src[i] == null) this.ask(`${GROUPS.ch.path(i)}/config/insrc`);
    for (let b = 0; b < 4; b++) if (this.route[b] == null) this.ask(ROUTE_PATH(b));
    for (const [h, v] of Object.entries(this.hamp)) if (v == null) this.ask(`/headamp/${pad3(Number(h))}/gain`);
  }

  // Texto para ver qué contesta la mesa (se abre desde la app en /diagnostico).
  diagnostics() {
    const L = [];
    L.push(`Respuestas recibidas de la mesa: fader ${this.rx.fader}, on ${this.rx.on}, fuente ${this.rx.insrc}, enrutado ${this.rx.route}, previo ${this.rx.headamp}`);
    L.push(`Estado publicado: ${this.ready ? 'sí' : 'no'}`);
    L.push(`Enrutado de entradas (bloques 1-8, 9-16, 17-24, 25-32): ${JSON.stringify(this.route)}`);
    L.push('');
    L.push('Canal | fuente | previo | ganancia (dB)');
    for (let i = 0; i < 32; i++) L.push(`${String(i + 1).padStart(5)} | ${String(this.src[i] ?? '?').padStart(6)} | ${String(this.hampOf[i] ?? '-').padStart(6)} | ${this.cs.ch[i].gain ?? '-'}`);
    L.push('');
    L.push('Valores en bruto recibidos (dirección -> argumentos):');
    for (const [a, v] of Object.entries(this.raw)) L.push(`  ${a} -> ${v}`);
    return L.join('\n');
  }

  // Mensaje de la mesa. Devuelve true si era de control.
  onMessage(m) {
    const v = m.args[0];
    let r;
    if ((r = /^\/(ch|bus|mtx)\/(\d\d)\/mix\/(fader|on)$/.exec(m.address)) || (r = /^\/(main)\/st\/mix\/(fader|on)$/.exec(m.address))) {
      const g = r[1], i = g === 'main' ? 0 : Number(r[2]) - 1, key = r[r.length - 1];
      if (!this.cs[g] || !this.cs[g][i] || typeof v !== 'number') return true;
      this.rx[key]++;
      this.setVal(g, i, key, key === 'fader' ? toDbOut(v) : v === 1);
      return true;
    }
    if ((r = /^\/ch\/(\d\d)\/config\/insrc$/.exec(m.address))) {
      this.rx.insrc++; this.keep(m);
      this.src[Number(r[1]) - 1] = v; this.refreshHamp(); return true;
    }
    if ((r = /^\/config\/routing\/IN\/(\d+)-\d+$/.exec(m.address))) {
      this.rx.route++; this.keep(m);
      this.route[(Number(r[1]) - 1) / 8] = v; this.refreshHamp(); return true;
    }
    if ((r = /^\/headamp\/(\d{3})\/gain$/.exec(m.address))) {
      this.rx.headamp++; this.keep(m);
      const h = Number(r[1]);
      if (typeof v === 'number') { this.hamp[h] = fToGain(v); this.refreshHamp(); }
      return true;
    }
    if ((r = /^\/config\/(ch|bus|mtx)link\/(\d+)-\d+$/.exec(m.address))) {
      const g = r[1], k = (Number(r[2]) - 1) / 2;
      this.linkState = this.linkState || { ch: [], bus: [], mtx: [] };
      this.linkState[g][k] = v === 1;
      this.setLinks(g);
      return true;
    }
    return false;
  }

  // Petición desde la app. Devuelve el valor ya ajustado (en las unidades de la app) o undefined si no se puede.
  set(g, i, key, value) {
    const c = this.cs[g] && this.cs[g][i];
    if (!this.ready || !c) return undefined;
    const base = GROUPS[g].path(i);
    // Un canal o bus enlazado como pareja estéreo se mueve junto con su pareja.
    const targets = c.pair >= 0 ? [i, c.pair] : [i];
    if (key === 'fader') {
      const f = quant(dbToFader(value === -Infinity || value == null ? -90 : Number(value)));
      const out = toDbOut(f);
      for (const j of targets) { this.queueSet(`${GROUPS[g].path(j)}/mix/fader`, osc.float(f)); if (j !== i) this.setVal(g, j, 'fader', out); }
      c.fader = out;
      return out;
    }
    if (key === 'on') {
      const on = value ? 1 : 0;
      for (const j of targets) { this.queueSet(`${GROUPS[g].path(j)}/mix/on`, on); if (j !== i) this.setVal(g, j, 'on', !!on); }
      c.on = !!on;
      return !!on;
    }
    if (key === 'gain' && g === 'ch') {
      const h = this.hampOf[i];
      if (h == null || c.gain == null) return undefined;
      const db = Math.min(GAIN_MAX, Math.max(GAIN_MIN, Math.round(value)));
      this.queueSet(`/headamp/${pad3(h)}/gain`, osc.float(gainToF(db)));
      this.hamp[h] = db;
      // Los canales que comparten ese previo muestran el mismo valor.
      for (let j = 0; j < 32; j++) if (this.hampOf[j] === h && j !== i) this.setVal('ch', j, 'gain', db);
      c.gain = db;
      return db;
    }
    return undefined;
  }

  // Se agrupan los movimientos: como mucho un envío cada 40 ms por parámetro.
  queueSet(addr, arg) {
    this.pend.set(addr, arg);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      for (const [a, v] of this.pend) this.tx(a, [v]);
      this.pend.clear();
    }, 40);
  }
}

module.exports = { X32Control, faderToDb, dbToFader, headampOf };

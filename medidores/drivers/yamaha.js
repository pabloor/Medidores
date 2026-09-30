// Driver para mesas Yamaha por RCP (Remote Control Protocol): TCP, puerto 49280, comandos de texto.
// Modelos: TF1/3/5, TF-Rack, DM3, DM7, CL1/3/5, QL1/5 y Rivage PM.
//
// Medidores:  mtrstart MIXER:Current/InCh/PreHPF 50
// Respuesta:  NOTIFY mtr MIXER:Current/InCh/PreHPF level 5a 60 7e ...   (hexadecimal)
// La suscripción caduca a los ~10 s: hay que repetir mtrstart periódicamente.
// Conversión: dB = valor - 126. La DM7 usa otra escala (tabla en yamaha-dm7-meter.json, verificada con una DM7C).
//
// Control:    get/set MIXER:Current/InCh/Fader/Level <canal> 0 <valor en centésimas de dB, -32768 = -inf>
//             La mesa avisa de los cambios hechos en ella con: NOTIFY set <dirección> <x> <y> <valor> "<texto>"
// Fuente: módulo yamaha-rcp de Bitfocus Companion (licencia MIT) y especificaciones RCP de Yamaha.
const net = require('net');
const EventEmitter = require('events');
const DM7_TABLE = require('./yamaha-dm7-meter.json');

const PORT = 49280;
const INTERVAL_MS = 50;
const RENEW_MS = 8000;
const NEG_INF = -32768;

const GROUPS = [
  // Canales de entrada medidos antes del HPF (lo más cercano a la entrada: útil para ajustar ganancias).
  // DM7, DM3 y TF ofrecen PreHPF|PreFader|PostOn; si la mesa no acepta PreHPF, se prueba el siguiente.
  { id: 'ch', name: 'Canales', path: 'MIXER:Current/InCh', picks: ['PreHPF', 'PreFader', 'PostOn'], num: (i) => `${i}` },
  { id: 'stin', name: 'Entradas estéreo', path: 'MIXER:Current/StInCh', picks: ['PreFader', 'PostOn'], num: (i) => `ST${i}` },
  { id: 'fxr', name: 'Retornos FX', path: 'MIXER:Current/FxRtnCh', picks: ['PreFader', 'PostOn'], num: (i) => `FX${i}` },
  { id: 'bus', name: 'Mix', path: 'MIXER:Current/Mix', picks: ['PostOn'], num: (i) => `MX${i}` },
  { id: 'mtx', name: 'Matrices', path: 'MIXER:Current/Mtrx', picks: ['PostOn'], num: (i) => `MT${i}` },
  { id: 'mono', name: 'Mono', path: 'MIXER:Current/Mono', picks: ['PostOn'], num: () => 'M' },
  { id: 'main', name: 'Stereo', path: 'MIXER:Current/St', picks: ['PostOn'], num: (i, n) => (n === 4 ? ['AL', 'AR', 'BL', 'BR'][i - 1] : i === 1 ? 'L' : 'R') },
];

// Ganancia del previo según el modelo (null = no documentada).
function gainProfile(model) {
  if (/DM7/i.test(model)) return { path: 'MIXER:Current/InCh/Port/HA/Gain', scale: 1, min: -6, max: 66 };
  if (/DM3/i.test(model)) return { path: 'IO:Current/InCh/HAGain', scale: 1, min: 0, max: 64 };
  if (/^(CL|QL)/i.test(model)) return { path: 'MIXER:Current/InCh/Port/HA/Gain', scale: 100, min: -6, max: 66 };
  if (/PM|RIVAGE|CS-R|DSP-R/i.test(model)) return { path: 'MIXER:Current/InCh/Port/HA/Gain', scale: 100, min: -6, max: 66 };
  return null;
}

const FADER = { ch: 'MIXER:Current/InCh/Fader', main: 'MIXER:Current/St/Fader', bus: 'MIXER:Current/Mix/Fader', mtx: 'MIXER:Current/Mtrx/Fader' };

// Grupos de link de canales de entrada (verificado con el volcado de parámetros de una DM7C V1.73):
//   InputChLink/InCh/Assign <canal>          -> número de grupo (0 = sin vincular)
//   InputChLink/LinkParams/HA <grupo - 1>    -> 1 si el grupo vincula la ganancia del previo
// La mesa ya propaga por sí misma el fader y el ON de los canales vinculados, pero NO la ganancia
// cuando el cambio llega por red: eso lo hace este driver.
const LINK_ASSIGN = 'MIXER:Current/InputChLink/InCh/Assign';
const LINK_HA = 'MIXER:Current/InputChLink/LinkParams/HA';
// Canales emparejados en estéreo: InCh/Role vale "StereoL"/"StereoR" (o "Mono"). Es un mecanismo
// distinto de los grupos de link y la mesa tampoco propaga la ganancia que llega por red.
const ROLE = 'MIXER:Current/InCh/Role';

// La DM7 devuelve la ganancia en dB enteros en unos canales y en centésimas de dB en otros
// (según el tipo de previo al que va el canal; verificado con una DM7C: "21" y "2000" = 20,00 dB).
// Un valor fuera del rango en dB enteros solo puede estar en centésimas.
function gainScaleFor(raw, gp, current) {
  if (gp.scale === 100) return 100;
  if (Math.abs(raw) > gp.max) return 100;
  return current || gp.scale;
}

function tokens(line) {
  return (line.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));
}

class Yamaha extends EventEmitter {
  constructor(opts) {
    super();
    this.ip = typeof opts.ip === 'string' ? opts.ip : null;
    this.port = Number(opts['rcp-port'] || PORT);
    this.model = '';
    this.timers = [];
    this.meterPoint = ['PreHPF', 'PreFader', 'PostOn'].includes(opts.meterPoint) ? opts.meterPoint : 'PreHPF';
  }

  start() {
    if (!this.ip) {
      this.emit('status', { state: 'error', detail: 'Las mesas Yamaha no se anuncian en la red: indica la IP de la mesa.', key: 'st.needIp' });
      return;
    }
    this.connect();
    this.timers.push(setInterval(() => this.checkAlive(), 1000));
    this.timers.push(setInterval(() => this.flushSets(), 40));
  }

  // ---------- Conexión
  connect() {
    this.reset();
    this.emit('status', { state: 'connecting', detail: `Conectando con la Yamaha en ${this.ip}…`, key: 'st.connecting', p: { name: 'Yamaha', ip: this.ip } });
    const sock = (this.sock = net.connect(this.port, this.ip));
    sock.setEncoding('utf8');
    sock.setKeepAlive(true, 5000);
    sock.setTimeout(30000);
    let pending = '';
    sock.on('connect', async () => {
      this.connectedAt = Date.now();
      this.state = null;
      const info = await this.request('devinfo productname', 'devinfo');
      if (info.ok) this.model = info.t[3] || '';
      for (const g of GROUPS) await this.subscribeGroup(g);
      this.renewTimer = setInterval(() => this.renew(), RENEW_MS);
      this.linkTimer = setInterval(() => this.refreshLinks(), 5000);
    });
    sock.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      lines.forEach((l) => this.onLine(l.trim()));
    });
    sock.on('timeout', () => sock.destroy());
    sock.on('error', (e) => this.emit('status', { state: 'lost', detail: `No se puede conectar con ${this.ip}:${this.port} (${e.code || e.message})`, key: 'st.cantConnect', p: { ip: this.ip, port: this.port, msg: e.code || e.message } }));
    sock.on('close', () => {
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.connect(), 3000);
    });
  }

  reset() {
    if (this.busy && this.busy.timer) clearTimeout(this.busy.timer);
    clearTimeout(this.resyncTimer);
    this.sub = {};
    this.names = {};
    this.lastRx = 0;
    this.queue = [];
    this.busy = null;
    this.ctrl = null;
    this.ctrlLoading = false;
    this.pendingSets = new Map();
    clearInterval(this.renewTimer);
    clearInterval(this.linkTimer);
    this.refreshing = false;
    if (this.sock) { this.sock.removeAllListeners(); this.sock.destroy(); }
  }

  send(line) {
    if (this.sock && !this.sock.destroyed) this.sock.write(line + '\n');
  }

  // Cola de peticiones con respuesta: se envían de una en una porque los errores
  // de RCP no siempre repiten la dirección.
  request(line, action) {
    return new Promise((resolve) => {
      this.queue.push({ line, action, resolve });
      this.pump();
    });
  }
  pump() {
    if (this.busy || !this.queue.length) return;
    const item = (this.busy = this.queue.shift());
    this.send(item.line);
    item.timer = setTimeout(() => this.finish({ ok: false, timeout: true }), 1200);
  }
  finish(result) {
    const item = this.busy;
    if (!item) return;
    clearTimeout(item.timer);
    this.busy = null;
    item.resolve(result);
    this.pump();
  }

  // ---------- Medidores
  async subscribeGroup(g) {
    // En los canales de entrada, primero el punto de medida elegido en Ajustes.
    const picks = g.id === 'ch' ? [this.meterPoint, ...g.picks.filter((p) => p !== this.meterPoint)] : g.picks;
    for (const pick of picks) {
      const r = await this.request(`mtrstart ${g.path}/${pick} ${INTERVAL_MS}`, 'mtrstart');
      if (r.ok || r.timeout) {
        this.sub[g.id] = { pick, count: 0, levels: [], asked: false };
        if (g.id === 'ch' && pick !== this.meterPoint) this.emit('meterPoint', pick); // la mesa no admite el elegido
        return;
      }
    }
  }

  // Cambia el punto de medida de los canales de entrada sin reconectar.
  async setMeterPoint(point) {
    this.meterPoint = point;
    const s = this.sub && this.sub.ch;
    if (!s || !this.sock || this.sock.destroyed) return;
    const r = await this.request(`mtrstart MIXER:Current/InCh/${point} ${INTERVAL_MS}`, 'mtrstart');
    if (r.ok || r.timeout) {
      s.pick = point;
      if (this.raw) delete this.raw[Object.keys(this.raw).find((k) => k.startsWith('MIXER:Current/InCh/'))];
    }
    this.emit('meterPoint', s.pick);
  }

  renew() {
    for (const g of GROUPS) {
      const s = this.sub[g.id];
      if (s) this.send(`mtrstart ${g.path}/${s.pick} ${INTERVAL_MS}`);
    }
  }

  onLine(line) {
    if (!line) return;
    const t = tokens(line);
    const [status, action, address] = t;

    if (status === 'NOTIFY' && action === 'mtr') return this.onMeters(address, t.slice(3));
    if (status === 'NOTIFY' && action === 'set') return this.onParam(address, Number(t[3]), Number(t[5]));
    if (status === 'OK' && action === 'set') return this.onParam(address, Number(t[3]), Number(t[5]));
    if (status === 'ERROR' && action === 'set') { this.resyncSoon(); return; }

    if ((status === 'OK' || status === 'ERROR') && this.busy && this.busy.action === action) {
      this.finish({ ok: status === 'OK', t });
    }
  }

  onMeters(address, rest) {
    const g = GROUPS.find((x) => address === `${x.path}/${this.sub[x.id]?.pick}`);
    if (!g) return;
    const hex = rest.filter((v) => /^[0-9a-fA-F]{1,2}$/.test(v)).map((v) => parseInt(v, 16));
    const isDM7 = /DM7/i.test(this.model);
    const db = hex.map((v) => {
      const d = isDM7 ? DM7_TABLE[v] : v - 126;
      return d == null || d < -90 ? -90 : Math.min(d, 20);
    });
    const s = this.sub[g.id];
    s.levels = db;
    this.lastRx = Date.now();
    if (s.count !== db.length) {
      s.count = db.length;
      this.emitLayout();
    }
    if (!s.asked && s.count) { s.asked = true; this.askNames(g, s.count); }
    if (g.id === 'ch' && !this.ctrl && !this.ctrlLoading) this.loadControl(s.count);

    const active = GROUPS.filter((x) => this.sub[x.id]?.count);
    this.emit('levels', active.map((x) => this.sub[x.id].levels));
    this.raw = this.raw || {};
    this.raw[address] = db.map((v) => Math.round(v * 10) / 10);
    this.emit('raw', this.raw);
  }

  async askNames(g, count) {
    if (g.id === 'main' || g.id === 'mono') return;
    for (let i = 0; i < count; i++) {
      const r = await this.request(`get ${g.path}/Label/Name ${i} 0`, 'get');
      if (!r.ok) continue;
      const key = `${g.path}/Label/Name/${i}`;
      if (this.names[key] !== r.t[5]) {
        this.names[key] = r.t[5] || '';
        clearTimeout(this.layoutTimer);
        this.layoutTimer = setTimeout(() => this.emitLayout(), 300);
      }
    }
  }

  emitLayout() {
    const active = GROUPS.filter((g) => this.sub[g.id]?.count);
    if (!active.length) return;
    this.emit('layout', {
      mixer: { name: this.model ? `Yamaha ${this.model}` : 'Yamaha', model: this.model, ip: this.ip },
      groups: active.map((g) => {
        const n = this.sub[g.id].count;
        return {
          id: g.id,
          name: g.name,
          strips: Array.from({ length: n }, (_, k) => ({
            num: g.num(k + 1, n),
            name: this.names[`${g.path}/Label/Name/${k}`] || '',
          })),
        };
      }),
    });
  }

  // ---------- Control
  async readText(path, x) {
    const r = await this.request(`get ${path} ${x} 0`, 'get');
    return r.ok ? String(r.t[5] || '') : null;
  }

  // Parejas estéreo: canal StereoL seguido de su StereoR.
  stereoPairs(roles) {
    const partner = roles.map(() => -1);
    for (let i = 0; i + 1 < roles.length; i++) {
      if (/StereoL/i.test(roles[i] || '') && /StereoR/i.test(roles[i + 1] || '')) { partner[i] = i + 1; partner[i + 1] = i; }
    }
    return partner;
  }

  async readInt(path, x) {
    const r = await this.request(`get ${path} ${x} 0`, 'get');
    return r.ok ? Number(r.t[5]) : null;
  }

  async loadControl(count) {
    this.ctrlLoading = true;
    const gp = gainProfile(this.model);
    const ch = [];
    for (let i = 0; i < count; i++) {
      const lvl = await this.readInt(`${FADER.ch}/Level`, i);
      const on = await this.readInt(`${FADER.ch}/On`, i);
      const rawGain = gp ? await this.readInt(gp.path, i) : null;
      const scale = rawGain == null ? null : gainScaleFor(rawGain, gp);
      ch.push({ fader: lvl, on: on == null ? null : on === 1, gain: rawGain == null ? null : Math.round(rawGain / scale), gainScale: scale });
    }
    // Vínculos entre canales (si la mesa no los ofrece, no hay vínculos).
    const link = { assign: [], ha: {} };
    if (gp) {
      for (let i = 0; i < count; i++) link.assign.push((await this.readInt(LINK_ASSIGN, i)) || 0);
      for (const id of new Set(link.assign.filter((v) => v > 0))) link.ha[id] = (await this.readInt(LINK_HA, id - 1)) === 1;
    }
    const roles = [];
    if (gp) for (let i = 0; i < count; i++) roles.push(await this.readText(ROLE, i));
    link.stereo = this.stereoPairs(roles);
    this.link = link;
    ch.forEach((c, i) => { c.link = link.assign[i] || 0; c.stereo = link.stereo[i] >= 0; c.pair = link.stereo[i]; });

    const main = [];
    for (let x = 0; x < 2; x++) {
      const lvl = await this.readInt(`${FADER.main}/Level`, x);
      if (lvl == null) break; // la mesa solo tiene un Stereo
      const on = await this.readInt(`${FADER.main}/On`, x);
      main.push({ fader: lvl, on: on == null ? null : on === 1, gain: null });
    }
    // Mix y Matrices: fader y ON (se leen hasta que la mesa deja de responder; el número depende del modelo).
    const outs = {};
    for (const g of ['bus', 'mtx']) {
      outs[g] = [];
      for (let x = 0; x < 96; x++) {
        const lvl = await this.readInt(`${FADER[g]}/Level`, x);
        if (lvl == null) break;
        const on = await this.readInt(`${FADER[g]}/On`, x);
        outs[g].push({ fader: lvl, on: on == null ? null : on === 1, gain: null });
      }
    }
    if (!this.sock || this.sock.destroyed) return;
    this.ctrl = { ch, main, bus: outs.bus, mtx: outs.mtx };
    this.gp = gp;
    this.ctrlLoading = false;
    this.emitControl();
  }

  emitControl() {
    if (!this.ctrl) return;
    const toDb = (v) => (v == null ? null : v <= NEG_INF ? -Infinity : v / 100);
    const map = (arr) => arr.map((c) => ({ fader: toDb(c.fader), on: c.on, gain: c.gain, link: c.link || 0, stereo: !!c.stereo, pair: c.pair ?? -1 }));  // gainScale es interno
    this.emit('control', {
      caps: {
        gain: this.gp ? { min: this.gp.min, max: this.gp.max, step: 1 } : null,
        faderMax: 10,
        mainNames: this.ctrl.main.length === 2 ? ['Stereo A', 'Stereo B'] : ['Stereo'],
      },
      ch: map(this.ctrl.ch),
      main: map(this.ctrl.main),
      bus: map(this.ctrl.bus || []),
      mtx: map(this.ctrl.mtx || []),
    });
  }

  // Cambios que llegan de la mesa (NOTIFY) o confirmados (OK set).
  onParam(address, x, value) {
    if (!this.ctrl || !Number.isFinite(x) || !Number.isFinite(value)) return;
    let g, key, v;
    if (address === `${FADER.ch}/Level`) { g = 'ch'; key = 'fader'; v = value; }
    else if (address === `${FADER.ch}/On`) { g = 'ch'; key = 'on'; v = value === 1; }
    else if (address === `${FADER.main}/Level`) { g = 'main'; key = 'fader'; v = value; }
    else if (address === `${FADER.main}/On`) { g = 'main'; key = 'on'; v = value === 1; }
    else if (address === `${FADER.bus}/Level`) { g = 'bus'; key = 'fader'; v = value; }
    else if (address === `${FADER.bus}/On`) { g = 'bus'; key = 'on'; v = value === 1; }
    else if (address === `${FADER.mtx}/Level`) { g = 'mtx'; key = 'fader'; v = value; }
    else if (address === `${FADER.mtx}/On`) { g = 'mtx'; key = 'on'; v = value === 1; }
    else if (this.gp && address === this.gp.path) { g = 'ch'; key = 'gain'; }
    else if (address === LINK_ASSIGN && this.link) { this.setLink(x, value); return; }
    else if (address === LINK_HA && this.link) { this.link.ha[x + 1] = value === 1; return; }
    else return;
    const c = this.ctrl[g][x];
    if (key === 'gain' && c) {
      c.gainScale = gainScaleFor(value, this.gp, c.gainScale);
      v = Math.round(value / c.gainScale);
    }
    if (!c || c[key] === v) return;
    c[key] = v;
    const out = key === 'fader' ? (v <= NEG_INF ? -Infinity : v / 100) : v;
    this.emit('param', { g, i: x, key, value: out });
  }

  // Petición desde la app. Se agrupan los movimientos de fader: como mucho un envío cada 40 ms por parámetro.
  set(g, i, key, value) {
    if (!this.ctrl || !this.ctrl[g] || !this.ctrl[g][i]) return undefined;
    let path, raw;
    if (key === 'fader') {
      path = `${FADER[g]}/Level`;
      raw = value === -Infinity || value == null || value <= -138 ? NEG_INF : Math.round(Math.min(10, Math.max(-138, value)) * 100);
    } else if (key === 'on') {
      path = `${FADER[g]}/On`;
      raw = value ? 1 : 0;
    } else if (key === 'gain' && g === 'ch' && this.gp && this.ctrl.ch[i].gain != null) {
      path = this.gp.path;
      const target = Math.min(this.gp.max, Math.max(this.gp.min, Math.round(value)));
      raw = target * (this.ctrl.ch[i].gainScale || this.gp.scale);
      this.propagateGain(i, target - this.ctrl.ch[i].gain);
      this.ctrl.ch[i].gain = target;
    } else return undefined;
    this.pendingSets.set(`${path}|${i}`, raw);
    // Devuelve el valor ya recortado, en las unidades de la app.
    if (key === 'fader') return raw <= NEG_INF ? -Infinity : raw / 100;
    if (key === 'gain') return Math.round(raw / (this.ctrl.ch[i].gainScale || this.gp.scale));
    return raw === 1;
  }

  setLink(i, id) {
    if (!this.link || this.link.assign[i] === id) return;
    this.link.assign[i] = id;
    if (this.ctrl && this.ctrl.ch[i]) this.ctrl.ch[i].link = id;
    if (id > 0 && !(id in this.link.ha)) this.readInt(LINK_HA, id - 1).then((v) => { this.link.ha[id] = v === 1; });
    this.emit('param', { g: 'ch', i, key: 'link', value: id });
  }

  // La mesa no siempre avisa por red de los cambios de link: se releen cada 5 s.
  async refreshLinks() {
    if (!this.ctrl || !this.link || !this.gp || this.refreshing) return;
    this.refreshing = true;
    try {
      for (let i = 0; i < this.ctrl.ch.length; i++) {
        const v = await this.readInt(LINK_ASSIGN, i);
        if (v != null) this.setLink(i, v);
      }
      for (const id of new Set(this.link.assign.filter((v) => v > 0))) {
        const v = await this.readInt(LINK_HA, id - 1);
        if (v != null) this.link.ha[id] = v === 1;
      }
      const roles = [];
      for (let i = 0; i < this.ctrl.ch.length; i++) roles.push(await this.readText(ROLE, i));
      if (roles.some((r) => r != null)) {
        this.link.stereo = this.stereoPairs(roles);
        this.ctrl.ch.forEach((c, i) => {
          const st = this.link.stereo[i] >= 0;
          if (c.stereo !== st) { c.stereo = st; this.emit('param', { g: 'ch', i, key: 'stereo', value: st }); }
          if (c.pair !== this.link.stereo[i]) { c.pair = this.link.stereo[i]; this.emit('param', { g: 'ch', i, key: 'pair', value: c.pair }); }
        });
      }
    } finally { this.refreshing = false; }
  }

  // Aplica el mismo cambio de ganancia (en dB) al resto del grupo de link y a la pareja estéreo, como hace la mesa.
  propagateGain(i, delta) {
    if (!delta || !this.link) return;
    const members = new Set();
    const id = this.link.assign[i];
    if (id && this.link.ha[id]) this.link.assign.forEach((gid, j) => { if (gid === id) members.add(j); });
    const partner = this.link.stereo ? this.link.stereo[i] : -1;
    if (partner >= 0) members.add(partner);
    members.delete(i);
    for (const j of members) {
      const c = this.ctrl.ch[j];
      if (!c || c.gain == null) continue;
      const nv = Math.min(this.gp.max, Math.max(this.gp.min, c.gain + delta));
      if (nv === c.gain) continue;
      c.gain = nv;
      this.pendingSets.set(`${this.gp.path}|${j}`, nv * (c.gainScale || this.gp.scale));
      this.emit('param', { g: 'ch', i: j, key: 'gain', value: nv });
    }
  }

  flushSets() {
    if (!this.pendingSets || !this.pendingSets.size) return;
    for (const [k, raw] of this.pendingSets) {
      const [path, i] = k.split('|');
      this.send(`set ${path} ${i} 0 ${raw}`);
    }
    this.pendingSets.clear();
  }

  resyncSoon() {
    clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => { if (this.ctrl) { this.ctrl = null; this.loadControl(this.sub.ch?.count || 0); } }, 500);
  }

  checkAlive() {
    const alive = this.lastRx && Date.now() - this.lastRx < 3000;
    if (!alive && this.connectedAt && Date.now() - Math.max(this.lastRx, this.connectedAt) > 20000) {
      this.connectedAt = 0;
      this.sock && this.sock.destroy();
    }
    const state = alive ? 'connected' : 'lost';
    if (state === this.state) return;
    this.state = state;
    this.emit('status', {
      state,
      detail: alive
        ? `Yamaha ${this.model} (${this.ip})`
        : `Sin medidores de ${this.ip}. Comprueba la IP y que la mesa esté en la misma red.`,
      key: alive ? 'st.connected' : 'st.lostCheck',
      p: { name: `Yamaha ${this.model}`.trim(), ip: this.ip },
    });
  }

  stop() {
    this.timers.forEach(clearInterval);
    clearTimeout(this.retry);
    this.reset();
  }
}

module.exports = Yamaha;

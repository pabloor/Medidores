// Driver para mesas Yamaha por RCP (Remote Control Protocol): TCP, puerto 49280, comandos de texto.
// Modelos: TF1/3/5, TF-Rack, DM3, DM7, CL1/3/5, QL1/5 y Rivage PM.
//
// Medidores:  mtrstart MIXER:Current/InCh/PreHPF 50
// Respuesta:  NOTIFY mtr MIXER:Current/InCh/PreHPF level 5a 60 7e ...   (hexadecimal)
// La suscripción caduca a los ~10 s: hay que repetir mtrstart periódicamente.
// Conversión: dB = valor - 126. La DM7 usa otra escala (tabla en yamaha-dm7-meter.json, verificada con una DM7C).
//
// VERSIÓN SOLO LECTURA: este driver solo pide medidores y nombres de canal; no envía ningún cambio a la mesa.
// Fuente: módulo yamaha-rcp de Bitfocus Companion (licencia MIT) y especificaciones RCP de Yamaha.
const net = require('net');
const EventEmitter = require('events');
const DM7_TABLE = require('./yamaha-dm7-meter.json');

const PORT = 49280;
const INTERVAL_MS = 50;
const RENEW_MS = 8000;

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

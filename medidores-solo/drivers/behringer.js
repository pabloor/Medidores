// Driver para Behringer X32 / Midas M32 (UDP 10023) y Behringer XR / Midas MR (UDP 10024).
// Los medidores se piden con /meters y la mesa los envía durante ~10 s, así que se renueva cada 8 s.
// Los mapas de índices vienen de la documentación no oficial de la comunidad:
// compruébalos con tu mesa usando "Mostrar valores en bruto" en la app.
const dgram = require('dgram');
const os = require('os');
const EventEmitter = require('events');
const osc = require('./osc');

const pad2 = (n) => String(n).padStart(2, '0');
const lr = (i) => (i === 1 ? 'L' : 'R');

const PROFILES = {
  x32: {
    port: 10023,
    label: 'X32 / M32',
    meters: ['/meters/1', '/meters/2'], // 1: 32 canales + reducciones de ganancia; 2: buses, matrices, main
    decode: 'float',                     // float32 lineal, 1.0 = 0 dBFS
    groups: [
      { id: 'ch', name: 'Canales', src: 0, start: 0, count: 32, num: (i) => `${i}`, nameAddr: (i) => `/ch/${pad2(i)}/config/name` },
      { id: 'bus', name: 'Buses', src: 1, start: 0, count: 16, num: (i) => `B${i}`, nameAddr: (i) => `/bus/${pad2(i)}/config/name` },
      { id: 'mtx', name: 'Matrices', src: 1, start: 16, count: 6, num: (i) => `M${i}`, nameAddr: (i) => `/mtx/${pad2(i)}/config/name` },
      { id: 'main', name: 'Main', src: 1, start: 22, count: 2, num: lr },
    ],
  },
  xair: {
    port: 10024,
    label: 'XR / MR',
    meters: ['/meters/1'],
    decode: 'int16', // int16 con signo, en 1/256 dB
    groups: [
      { id: 'ch', name: 'Canales', src: 0, start: 0, count: 16, num: (i) => `${i}`, nameAddr: (i) => `/ch/${pad2(i)}/config/name` },
      { id: 'aux', name: 'Aux in', src: 0, start: 16, count: 2, num: lr },
      { id: 'fxr', name: 'Retornos FX', src: 0, start: 18, count: 8, num: (i) => `${Math.ceil(i / 2)}${i % 2 ? 'L' : 'R'}` },
      { id: 'bus', name: 'Buses', src: 0, start: 26, count: 6, num: (i) => `B${i}`, nameAddr: (i) => `/bus/${i}/config/name` },
      { id: 'fxs', name: 'Envíos FX', src: 0, start: 32, count: 4, num: (i) => `FX${i}` },
      { id: 'main', name: 'Main', src: 0, start: 36, count: 2, num: lr },
    ],
  },
};

const FAMILY_ALIASES = { x32: 'x32', m32: 'x32', xair: 'xair', xr: 'xair', mr: 'xair' };

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) {
        const ip = a.address.split('.').map(Number);
        const mask = a.netmask.split('.').map(Number);
        out.add(ip.map((b, i) => b | (~mask[i] & 255)).join('.'));
      }
    }
  }
  return [...out];
}

class Behringer extends EventEmitter {
  constructor(opts) {
    super();
    this.ip = typeof opts.ip === 'string' ? opts.ip : null;
    this.forced = FAMILY_ALIASES[opts.driver] || null;
    this.names = {};
    this.bufs = [];
    this.raw = {};
    this.lastRx = 0;
    this.timers = [];
  }

  start() {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m, r) => this.onMessage(m, r));
    this.sock.on('error', (e) => this.emit('status', { state: 'error', detail: `Error de red: ${e.message}`, key: 'st.netError', p: { msg: e.message } }));
    this.sock.bind(() => {
      this.sock.setBroadcast(true);
      if (this.ip && this.forced) this.connect(this.ip, this.forced, null);
      else this.discover();
    });
  }

  send(address, args, port, ip) {
    this.sock.send(osc.encode(address, args), port, ip);
  }

  discover() {
    const ports = this.forced ? [PROFILES[this.forced].port] : [10023, 10024];
    const targets = this.ip ? [this.ip] : broadcastAddresses();
    this.emit('status', {
      state: 'searching',
      detail: this.ip ? `Preguntando a ${this.ip}…` : 'Buscando mesas Behringer o Midas en la red…',
      key: this.ip ? 'st.asking' : 'st.bSearching',
      p: { ip: this.ip },
    });
    const ping = () => {
      if (this.profile) return;
      for (const t of targets) for (const p of ports) this.send('/xinfo', [], p, t);
    };
    ping();
    this.discoverTimer = setInterval(ping, 2000);
  }

  connect(ip, family, info) {
    clearInterval(this.discoverTimer);
    this.ip = ip;
    this.profile = PROFILES[family];
    this.info = info || {};
    this.emit('status', { state: 'connecting', detail: `Conectando con ${this.mixerName()} en ${ip}…`, key: 'st.connecting', p: { name: this.mixerName(), ip } });
    this.emitLayout();

    const subscribe = () => this.profile.meters.forEach((p) => this.send('/meters', [p], this.profile.port, ip));
    const askNames = () => {
      for (const g of this.profile.groups) {
        if (!g.nameAddr) continue;
        for (let i = 1; i <= g.count; i++) this.send(g.nameAddr(i), [], this.profile.port, ip);
      }
    };
    subscribe();
    askNames();
    if (!info) this.send('/xinfo', [], this.profile.port, ip);
    this.timers.push(setInterval(subscribe, 8000), setInterval(askNames, 15000));
    this.timers.push(setInterval(() => this.checkAlive(), 1000));
  }

  mixerName() {
    return this.info.name || this.info.model || this.profile.label;
  }

  checkAlive() {
    const alive = Date.now() - this.lastRx < 3000;
    const state = alive ? 'connected' : 'lost';
    if (state === this.state) return;
    this.state = state;
    this.emit('status', {
      state,
      detail: alive
        ? `${this.mixerName()} (${this.ip})`
        : `Sin medidores de ${this.ip}. Comprueba que la mesa esté encendida y en la misma red.`,
      key: alive ? 'st.connected' : 'st.lostCheck',
      p: { name: this.mixerName(), ip: this.ip },
    });
  }

  onMessage(buf, rinfo) {
    let m;
    try { m = osc.decode(buf); } catch { return; }

    if (m.address === '/xinfo') {
      const [, name, model, firmware] = m.args;
      const info = { name, model, firmware };
      if (!this.profile) this.connect(rinfo.address, rinfo.port === 10024 ? 'xair' : 'x32', info);
      else if (rinfo.address === this.ip) { this.info = info; this.emitLayout(); this.state = null; }
      return;
    }
    if (!this.profile || rinfo.address !== this.ip) return;

    const idx = this.profile.meters.indexOf(m.address);
    if (idx >= 0 && Buffer.isBuffer(m.args[0])) return this.onMeters(idx, m.args[0]);

    if (m.address.endsWith('/config/name') && typeof m.args[0] === 'string') {
      if (this.names[m.address] !== m.args[0]) {
        this.names[m.address] = m.args[0];
        clearTimeout(this.layoutTimer);
        this.layoutTimer = setTimeout(() => this.emitLayout(), 300);
      }
    }
  }

  onMeters(idx, blob) {
    if (blob.length < 4) return;
    const isFloat = this.profile.decode === 'float';
    const size = isFloat ? 4 : 2;
    const n = Math.min(blob.readInt32LE(0), Math.floor((blob.length - 4) / size), 512);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      if (isFloat) {
        const v = blob.readFloatLE(4 + i * 4);
        out[i] = v > 0 ? 20 * Math.log10(v) : -90;
      } else {
        out[i] = blob.readInt16LE(4 + i * 2) / 256;
      }
    }
    this.bufs[idx] = out;
    this.lastRx = Date.now();
    this.raw[this.profile.meters[idx]] = out.map((v) => Math.round(v * 10) / 10);

    const levels = this.profile.groups.map((g) => {
      const src = this.bufs[g.src] || [];
      return Array.from({ length: g.count }, (_, k) => src[g.start + k] ?? -90);
    });
    this.emit('levels', levels);
    this.emit('raw', this.raw);
  }

  emitLayout() {
    this.emit('layout', {
      mixer: { name: this.mixerName(), model: this.info.model || this.profile.label, ip: this.ip },
      groups: this.profile.groups.map((g) => ({
        id: g.id,
        name: g.name,
        strips: Array.from({ length: g.count }, (_, k) => ({
          num: g.num(k + 1),
          name: g.nameAddr ? this.names[g.nameAddr(k + 1)] || '' : '',
        })),
      })),
    });
  }

  stop() {
    clearInterval(this.discoverTimer);
    this.timers.forEach(clearInterval);
    try { this.sock.close(); } catch {}
  }
}

module.exports = Behringer;

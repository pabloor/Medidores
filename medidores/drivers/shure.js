// Control de ganancia de receptores inalámbricos Shure por red (Axient Digital AD4D/AD4Q; mismo comando
// en ULX-D, QLX-D y SLX-D). Protocolo publicado por Shure: TCP puerto 2202, mensajes de texto.
//   Leer:      < GET 1 AUDIO_GAIN >
//   Cambiar:   < SET 1 AUDIO_GAIN 30 >        valor = ganancia en dB + 18  (0..60 = -18..+42 dB)
//   Respuesta: < REP 1 AUDIO_GAIN 030 >       también llega cuando se cambia en el receptor o en Wireless Workbench
const net = require('net');
const os = require('os');
const EventEmitter = require('events');

const PORT = 2202;
const MIN = -18;
const MAX = 42;

class ShureReceiver extends EventEmitter {
  // map: { canalDelReceptor: indiceDeCanalDeLaMesa (0 = canal 1)}
  // nic: nombre del adaptador de red del ordenador por el que se conecta (p. ej. "en5"); vacío = lo decide el sistema.
  constructor(ip, map, nic) {
    super();
    this.ip = ip;
    this.nic = nic || '';
    this.map = map;
    this.gain = {};
    this.online = false;
    this.stopped = false;
  }

  start() {
    this.connect();
    // Consulta periódica: mantiene la conexión viva y detecta si el receptor desaparece.
    this.poll = setInterval(() => this.ask(), 10000);
  }

  connect() {
    if (this.stopped) return;
    let localAddress;
    if (this.nic) {
      // Se conecta desde la dirección de ese adaptador. Si no está disponible (cable desenchufado), no se
      // conecta por otro camino: se queda sin conexión y reintenta.
      const a = (os.networkInterfaces()[this.nic] || []).find((x) => (x.family === 'IPv4' || x.family === 4) && !x.internal);
      if (!a) { this.setOnline(false); this.retry = setTimeout(() => this.connect(), 3000); return; }
      localAddress = a.address;
    }
    const sock = (this.sock = net.connect({ port: PORT, host: this.ip, ...(localAddress ? { localAddress } : {}) }));
    sock.setEncoding('ascii');
    sock.setTimeout(25000);
    let buf = '';
    sock.on('connect', () => { this.setOnline(true); this.ask(); });
    sock.on('data', (d) => {
      buf += d;
      let end;
      while ((end = buf.indexOf('>')) >= 0) {
        const msg = buf.slice(0, end).replace('<', '').trim();
        buf = buf.slice(end + 1);
        this.onMessage(msg);
      }
    });
    sock.on('timeout', () => sock.destroy());
    sock.on('error', () => {});
    sock.on('close', () => {
      this.setOnline(false);
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 3000);
    });
  }

  setOnline(v) {
    if (this.online === v) return;
    this.online = v;
    this.emit('status', v);
  }

  send(cmd) {
    if (this.sock && !this.sock.destroyed && this.online) this.sock.write(`< ${cmd} >`);
  }

  ask() {
    for (const ch of Object.keys(this.map)) this.send(`GET ${ch} AUDIO_GAIN`);
  }

  onMessage(msg) {
    const [kind, ch, key, value] = msg.split(/\s+/);
    if (kind !== 'REP' || key !== 'AUDIO_GAIN' || !(ch in this.map)) return;
    const db = parseInt(value, 10) - 18;
    if (!Number.isFinite(db) || this.gain[ch] === db) return;
    this.gain[ch] = db;
    this.emit('gain', { i: this.map[ch], value: db });
  }

  // Devuelve el valor ya recortado.
  setGain(consoleIndex, db) {
    const ch = Object.keys(this.map).find((k) => this.map[k] === consoleIndex);
    if (ch == null || !this.online) return undefined;
    const v = Math.min(MAX, Math.max(MIN, Math.round(db)));
    this.send(`SET ${ch} AUDIO_GAIN ${v + 18}`);
    return v;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.poll);
    clearTimeout(this.retry);
    if (this.sock) { this.sock.removeAllListeners(); this.sock.destroy(); }
  }
}

module.exports = { ShureReceiver, MIN, MAX };

// Driver EXPERIMENTAL para DiGiCo SD, Quantum y S21/S31.
//
// DiGiCo no publica medidores en su OSC general. Solo los envía por el protocolo de la app de iPad,
// que la comunidad ha descifrado parcialmente (proyecto S21_HiJack). Lo que se sabe:
//   - La app se registra en la mesa como dispositivo "DiGiCo Pad" (Setup > External Control).
//   - Consultas con "/?" al final: /Console/Name/?, /Console/Input_Channels/? ...
//   - Suscripción por canal: /Input_Channels/N/Channel_Input/post_meter <id> <1>
//   - La mesa envía /Meters/values <id> <valor> <id> <valor> ...
// Lo que NO se sabe con certeza: la escala exacta de los valores y si la suscripción caduca.
// Por eso hay --digico-scale y --sniff para investigar con una mesa real.
const dgram = require('dgram');
const EventEmitter = require('events');
const osc = require('./osc');

class DiGiCo extends EventEmitter {
  constructor(opts) {
    super();
    this.ip = typeof opts.ip === 'string' ? opts.ip : null;
    this.sendPort = Number(opts['send-port'] || 8000);     // puerto de recepción configurado en la mesa
    this.listenPort = Number(opts['listen-port'] || 9000); // puerto de envío configurado en la mesa
    this.fallbackCount = Number(opts.channels || 48);
    this.scale = opts['digico-scale'] || 'auto';            // auto | linear | db | pos
    this.sniff = !!opts.sniff;
    this.count = 0;
    this.names = {};
    this.values = [];
    this.seen = new Set();
    this.timers = [];
    this.lastRx = 0;
  }

  start() {
    if (!this.ip) {
      this.emit('status', { state: 'error', detail: 'Indica la IP de la DiGiCo con --ip 192.168.x.x', key: 'st.needIp' });
      return;
    }
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m) => this.onMessage(m));
    this.sock.on('error', (e) => this.emit('status', {
      state: 'error',
      detail: e.code === 'EADDRINUSE' ? `El puerto UDP ${this.listenPort} está ocupado. Usa --listen-port.` : `Error de red: ${e.message}`,
      key: e.code === 'EADDRINUSE' ? 'st.portBusy' : 'st.netError',
      p: { port: this.listenPort, msg: e.message },
    }));
    this.sock.bind(this.listenPort, () => this.handshake());
    this.timers.push(setInterval(() => this.checkAlive(), 1000));
  }

  send(address, args = []) {
    this.sock.send(osc.encode(address, args), this.sendPort, this.ip);
  }

  handshake() {
    this.emit('status', { state: 'connecting', detail: `Contactando con la DiGiCo en ${this.ip} (envío ${this.sendPort}, escucha ${this.listenPort})…`, key: 'st.digicoConnecting', p: { ip: this.ip, send: this.sendPort, listen: this.listenPort } });
    ['/Console/Name/?', '/Console/Input_Channels/?', '/Console/Channels/?'].forEach((q, i) => setTimeout(() => this.send(q), i * 50));
    clearTimeout(this.countTimer);
    // Si la mesa no dice cuántos canales tiene, se usa --channels.
    this.countTimer = setTimeout(() => { if (!this.count) this.setCount(this.fallbackCount); }, 3000);
  }

  setCount(n) {
    if (!n || n === this.count) return;
    this.count = Math.min(n, 256);
    this.values = new Array(this.count).fill(-90);
    this.emitLayout();
    this.subscribe();
  }

  subscribe() {
    this.send('/Meters/clear');
    for (let i = 1; i <= this.count; i++) {
      setTimeout(() => {
        this.send(`/Input_Channels/${i}/Channel_Input/post_meter`, [i, 1]);
        this.send(`/Input_Channels/${i}/Channel_Input/name/?`);
      }, 20 + i * 8); // espaciado: se sabe que las SD pierden ráfagas
    }
    this.subscribedAt = Date.now();
  }

  onMessage(buf) {
    let m;
    try { m = osc.decode(buf); } catch { return; }
    if (this.sniff && m.address !== '/Meters/values' && !this.seen.has(m.address)) {
      this.seen.add(m.address);
      console.log('[digico]', m.address, JSON.stringify(m.args.map((a) => (Buffer.isBuffer(a) ? `<${a.length} bytes>` : a))));
    }

    if (m.address === '/Meters/values') return this.onMeters(m.args);
    if (m.address === '/Console/Name') { this.consoleName = String(m.args[0] || '').split(' ')[0]; this.emitLayout(); return; }
    if ((m.address === '/Console/Input_Channels' || m.address === '/Console/Channels') && Number.isInteger(m.args[0])) {
      return this.setCount(m.args[0]);
    }
    const nm = m.address.match(/^\/Input_Channels\/(\d+)\/Channel_Input\/name$/);
    if (nm && typeof m.args[0] === 'string') {
      this.names[nm[1]] = m.args[0];
      clearTimeout(this.layoutTimer);
      this.layoutTimer = setTimeout(() => this.emitLayout(), 300);
    }
  }

  toDb(v) {
    const mode = this.scale === 'auto' ? (v < 0 ? 'db' : 'linear') : this.scale;
    if (mode === 'db') return v;
    if (mode === 'pos') return v <= 0 ? -90 : -60 + 60 * Math.min(v, 1); // posición 0..1 aproximada
    return v > 0 ? 20 * Math.log10(v) : -90; // amplitud lineal, 1.0 = 0 dBFS
  }

  onMeters(args) {
    if (!this.count) return;
    this.lastRx = Date.now();
    this.raw = this.raw || { '/Meters/values': [] };
    for (let i = 0; i + 1 < args.length; i += 2) {
      const id = Number(args[i]), v = Number(args[i + 1]);
      if (!Number.isFinite(id) || !Number.isFinite(v)) continue;
      this.raw['/Meters/values'][id] = Math.round(v * 1000) / 1000;
      if (id >= 1 && id <= this.count) this.values[id - 1] = Math.max(-90, Math.min(20, this.toDb(v)));
    }
    this.emit('levels', [this.values]);
    this.emit('raw', this.raw);
  }

  emitLayout() {
    if (!this.count) return;
    this.emit('layout', {
      mixer: { name: this.consoleName ? `DiGiCo ${this.consoleName}` : 'DiGiCo', model: this.consoleName || 'DiGiCo', ip: this.ip },
      groups: [{
        id: 'ch',
        name: 'Canales',
        strips: Array.from({ length: this.count }, (_, k) => ({ num: `${k + 1}`, name: this.names[k + 1] || '' })),
      }],
    });
  }

  checkAlive() {
    const alive = Date.now() - this.lastRx < 3000;
    // Sin medidores tras suscribir: repetir el saludo cada 8 s.
    if (!alive && this.subscribedAt && Date.now() - this.subscribedAt > 8000) {
      this.subscribedAt = 0;
      this.count = 0;
      this.handshake();
    }
    const state = alive ? 'connected' : 'lost';
    if (state === this.state) return;
    this.state = state;
    this.emit('status', {
      state,
      detail: alive
        ? `${this.consoleName ? 'DiGiCo ' + this.consoleName : 'DiGiCo'} (${this.ip})`
        : `Sin medidores de ${this.ip}. Revisa External Control en la mesa (dispositivo "DiGiCo Pad", puertos ${this.sendPort}/${this.listenPort}).`,
      key: alive ? 'st.connected' : 'st.digicoLost',
      p: { name: this.consoleName ? `DiGiCo ${this.consoleName}` : 'DiGiCo', ip: this.ip, send: this.sendPort, listen: this.listenPort },
    });
  }

  stop() {
    this.timers.forEach(clearInterval);
    clearTimeout(this.countTimer);
    try { this.sock.close(); } catch {}
  }
}

module.exports = DiGiCo;

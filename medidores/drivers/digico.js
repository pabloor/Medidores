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
const os = require('os');
const EventEmitter = require('events');
const osc = require('./osc');

class DiGiCo extends EventEmitter {
  constructor(opts) {
    super();
    this.ip = typeof opts.ip === 'string' ? opts.ip : null;
    this.sendPort = Number(opts['send-port'] || 8000);     // puerto de recepción configurado en la mesa
    this.listenPort = Number(opts['listen-port'] || 9000); // puerto de envío configurado en la mesa
    this.fallbackCount = Number(opts.channels || 48);
    this.nic = typeof opts.nic === 'string' && /^[A-Za-z0-9_.:-]{1,16}$/.test(opts.nic) ? opts.nic : ''; // adaptador de red del ordenador (vacío = automático)
    this.scale = opts['digico-scale'] || 'auto';            // auto | linear | db | pos
    this.sniff = !!opts.sniff;
    this.count = 0;
    this.names = {};
    this.values = [];
    this.seen = new Set();
    this.timers = [];
    this.lastRx = 0;   // último medidor recibido
    this.lastAny = 0;  // último paquete de cualquier tipo recibido de la mesa
    // Diagnóstico: qué se ha enviado a la mesa y qué ha llegado (se consulta en /diagnostico).
    this.startedAt = Date.now();
    this.tx = { total: 0, byAddress: new Map(), errors: [] };
    this.rx = { total: 0, bundles: 0, bySource: new Map(), byAddress: new Map(), bad: [], last: 0 };
    this.cs = null;        // control de los canales de entrada: { ch: [{ fader, on, gain }] }
    this.ctlReady = false;
    this.pendSets = new Map();
    this.chVals = new Map(); // parámetro -> Map(canal -> { v, tags, t, n }): último valor que la mesa ha enviado de cada canal
  }

  start() {
    if (!this.ip) {
      this.emit('status', { state: 'error', detail: 'Indica la IP de la DiGiCo con --ip 192.168.x.x', key: 'st.needIp' });
      return;
    }
    // Con un adaptador elegido, el socket se abre en la dirección de ese adaptador: se envía desde ella y solo se recibe por ella.
    // Si el adaptador no está disponible (cable desenchufado) no se usa otro: se avisa y se reintenta.
    let bindAddr;
    if (this.nic) {
      const a = (os.networkInterfaces()[this.nic] || []).find((x) => (x.family === 'IPv4' || x.family === 4) && !x.internal);
      if (!a) {
        this.emit('status', { state: 'error', detail: `El adaptador de red "${this.nic}" no está disponible. Conéctalo o elige otro.`, key: 'st.nicGone', p: { nic: this.nic } });
        this.retryStart = setTimeout(() => this.start(), 3000);
        return;
      }
      bindAddr = a.address;
      this.localRoute = a.address;
    }
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m, r) => this.onMessage(m, r));
    this.sock.on('error', (e) => this.emit('status', {
      state: 'error',
      detail: e.code === 'EADDRINUSE' ? `El puerto UDP ${this.listenPort} está ocupado. Usa --listen-port.` : `Error de red: ${e.message}`,
      key: e.code === 'EADDRINUSE' ? 'st.portBusy' : 'st.netError',
      p: { port: this.listenPort, msg: e.message },
    }));
    this.sock.bind(this.listenPort, bindAddr, () => this.handshake());
    this.timers.push(setInterval(() => this.checkAlive(), 1000));
  }

  send(address, args = []) {
    const key = address.replace(/\/\d+\//g, '/N/'); // los canales se agrupan: /Input_Channels/N/…
    this.tx.total++;
    this.tx.byAddress.set(key, (this.tx.byAddress.get(key) || 0) + 1);
    this.sock.send(osc.encode(address, args), this.sendPort, this.ip, (err) => {
      if (err && this.tx.errors.length < 10) this.tx.errors.push(`${new Date().toLocaleTimeString()} ${err.code || ''} ${err.message}`);
    });
  }

  // Averigua qué dirección de este ordenador usa el sistema para llegar a la mesa (un "connect" UDP no envía nada).
  // Red que se está usando, para mostrarla: adaptador elegido (o "automático") y la dirección de este ordenador.
  netLabel() {
    return `${this.nic ? this.nic : 'auto'}${this.localRoute ? ' ' + this.localRoute : ''}`;
  }

  probeRoute() {
    if (this.nic) return; // con un adaptador elegido la dirección ya se conoce
    try {
      const probe = dgram.createSocket('udp4');
      probe.on('error', () => { try { probe.close(); } catch {} });
      probe.connect(this.sendPort, this.ip, () => {
        try { this.localRoute = probe.address().address; } catch {}
        try { probe.close(); } catch {}
      });
    } catch {}
  }

  handshake() {
    this.probeRoute();
    if (!this.state) this.emit('status', { state: 'connecting', detail: `Contactando con la DiGiCo en ${this.ip} (envío ${this.sendPort}, escucha ${this.listenPort}) · red: ${this.netLabel()}…`, key: 'st.digicoConnecting', p: { ip: this.ip, send: this.sendPort, listen: this.listenPort, net: this.netLabel() } });
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
    this.initControl();
  }

  // ---- Control de canales de entrada: fader (dB), ON (= no mute) y ganancia del previo (analog_gain, dB).
  // Escalas según la documentación de la comunidad y las respuestas de una Quantum:
  //   /Input_Channels/N/fader                      float dB, -150 (−∞) … +10
  //   /Input_Channels/N/mute                       float 0/1 (1 = silenciado)
  //   /Input_Channels/N/Channel_Input/analog_gain  float dB, -20 … +60
  initControl() {
    if (this.cs && this.cs.ch.length === this.count) return; // el saludo se repite: no reiniciar el estado
    clearTimeout(this.ctlTimer);
    this.ctlReady = false;
    this.cs = { ch: Array.from({ length: this.count }, () => ({ fader: null, on: null, gain: null })) };
    for (let i = 1; i <= this.count; i++) {
      setTimeout(() => {
        this.send(`/Input_Channels/${i}/fader/?`);
        this.send(`/Input_Channels/${i}/mute/?`);
        this.send(`/Input_Channels/${i}/Channel_Input/analog_gain/?`);
      }, 150 + i * 15);
    }
    // Se publica lo que haya contestado la mesa; lo que falte llega después como cambios sueltos.
    this.ctlTimer = setTimeout(() => { this.ctlReady = true; this.emit('control', this.encodeControl()); }, 150 + this.count * 15 + 1500);
  }

  encodeControl() {
    const map = (arr) => arr.map((c) => ({ fader: c.fader, on: c.on, gain: c.gain, link: 0, stereo: false, pair: -1 }));
    return { caps: { gain: { min: -20, max: 60, step: 0.5 }, faderMax: 10, mainNames: ['Stereo'] }, ch: map(this.cs.ch), main: [], bus: [], mtx: [] };
  }

  ctlUpdate(i, param, v) {
    const c = this.cs && this.cs.ch[i];
    if (!c) return;
    let key, val;
    if (param === 'fader') { key = 'fader'; val = v <= -90 ? -Infinity : Math.round(v * 10) / 10; }
    else if (param === 'mute') { key = 'on'; val = v < 0.5; }
    else { key = 'gain'; val = Math.round(v * 10) / 10; }
    if (c[key] === val) return;
    c[key] = val;
    if (this.ctlReady) this.emit('param', { g: 'ch', i, key, value: val });
  }

  // Petición desde la app. Devuelve el valor ya ajustado o undefined si no se puede.
  set(g, i, key, value) {
    const c = g === 'ch' && this.cs && this.ctlReady && this.cs.ch[i];
    if (!c) return undefined;
    const n = i + 1;
    let addr, arg, out;
    if (key === 'fader') {
      const db = value === -Infinity || value == null || value <= -90 ? -150 : Math.min(10, Math.max(-150, Number(value)));
      addr = `/Input_Channels/${n}/fader`; arg = osc.float(db); out = db <= -90 ? -Infinity : Math.round(db * 10) / 10;
    } else if (key === 'on') {
      addr = `/Input_Channels/${n}/mute`; arg = osc.float(value ? 0 : 1); out = !!value;
    } else if (key === 'gain' && c.gain != null) {
      const db = Math.min(60, Math.max(-20, Math.round(Number(value) * 2) / 2)); // pasos de 0,5 dB
      addr = `/Input_Channels/${n}/Channel_Input/analog_gain`; arg = osc.float(db); out = db;
    } else return undefined;
    c[key] = out;
    // Se agrupan los movimientos: como mucho un envío cada 40 ms por parámetro.
    this.pendSets.set(addr, arg);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      for (const [a, v] of this.pendSets) this.send(a, [v]);
      this.pendSets.clear();
    }, 40);
    return out;
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

  // DiGiCo manda algunos medidores como un OSC "sin etiquetas": dirección + floats directamente, sin ",f".
  // Devuelve { address, floats } si el paquete es de ese tipo, y null si no.
  parseUntaggedMeter(buf) {
    const end = buf.indexOf(0);
    if (end < 1 || buf[0] !== 0x2f) return null; // la dirección empieza por "/"
    const address = buf.toString('utf8', 0, end);
    if (!/meter/i.test(address)) return null;
    const off = (end + 4) & ~3;
    const rest = buf.length - off;
    if (rest < 4 || rest % 4 !== 0 || rest > 32 || buf[off] === 0x2c) return null; // 0x2c = "," : sí tiene etiquetas
    const floats = [];
    for (let p = off; p < buf.length; p += 4) floats.push(buf.readFloatBE(p));
    return { address, floats };
  }

  onMessage(buf, rinfo) {
    // Con "Bundles" activado en External Control, la mesa agrupa varios mensajes OSC en un paquete "#bundle".
    if (buf.length >= 16 && buf.toString('ascii', 0, 8) === '#bundle\0') {
      this.rx.bundles++;
      let off = 16;
      while (off + 4 <= buf.length) {
        const size = buf.readUInt32BE(off);
        if (size === 0 || off + 4 + size > buf.length) break;
        this.onMessage(buf.subarray(off + 4, off + 4 + size), rinfo); // cada elemento es un mensaje (o un bundle anidado)
        off += 4 + size;
      }
      return;
    }
    this.rx.total++;
    this.lastAny = Date.now();
    this.rx.last = Date.now();
    if (rinfo) { const s = `${rinfo.address}:${rinfo.port}`; this.rx.bySource.set(s, (this.rx.bySource.get(s) || 0) + 1); }
    const um = this.parseUntaggedMeter(buf);
    if (this.meterProbe) {
      // Prueba de medidores sueltos: se apunta cada respuesta a un medidor consultado; el resto cuenta como "otros".
      const addr = um ? um.address : (() => { const e = buf.indexOf(0); return e > 0 ? buf.toString('utf8', 0, e) : ''; })();
      const slot = this.meterProbe.series.get(addr);
      if (slot) { let vals = um ? um.floats : null; if (!vals) { try { vals = osc.decode(buf).args; } catch { vals = ['?']; } } slot.push(vals.map((v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v))); }
      else this.meterProbe.other++;
    }
    if (um) {
      const key = um.address.replace(/\/\d+\//g, '/N/');
      const e = this.rx.byAddress.get(key) || { n: 0, sample: '' };
      e.n++;
      if (!e.sample) e.sample = `(sin etiquetas) ${JSON.stringify(um.floats.map((f) => Math.round(f * 1000) / 1000))}`;
      this.rx.byAddress.set(key, e);
      if (this.probeLog && this.probeLog.items.length < 8) this.probeLog.items.push(`${um.address}  (medidor sin etiquetas) ${JSON.stringify(um.floats.map((f) => Math.round(f * 1000) / 1000))}`);
      // Medidor de un canal de entrada: /Input_Channels/N/…meter → el primer float es el nivel.
      const cm = /^\/Input_Channels\/(\d+)\/.*(post|pre)_meter$/i.exec(um.address);
      if (cm && this.count && um.floats.length) {
        const i = Number(cm[1]);
        if (i >= 1 && i <= this.count) { this.lastRx = Date.now(); this.values[i - 1] = Math.max(-90, Math.min(20, this.toDb(um.floats[0]))); this.emit('levels', [this.values]); }
      }
      return;
    }
    let m;
    try { m = osc.decode(buf); } catch {
      if (this.probeLog && this.probeLog.items.length < 8) this.probeLog.items.push(`(no es OSC) ${buf.length} bytes: ${buf.subarray(0, 40).toString('hex')}`);
      if (this.rx.bad.length < 5) this.rx.bad.push(`${buf.length} bytes: ${buf.subarray(0, 48).toString('hex')}`);
      return;
    }
    if (this.cs) {
      const cm = /^\/Input_Channels\/(\d+)\/(fader|mute|Channel_Input\/analog_gain)$/.exec(m.address);
      if (cm && typeof m.args[0] === 'number') this.ctlUpdate(Number(cm[1]) - 1, cm[2] === 'fader' ? 'fader' : cm[2] === 'mute' ? 'mute' : 'gain', m.args[0]);
    }
    if (this.probeLog && this.probeLog.items.length < 8 && !/^\/Console\//.test(m.address) && !/\/name$/.test(m.address)) {
      this.probeLog.items.push(`${m.address} ,${m.tags} ${JSON.stringify(m.args.map((a) => (Buffer.isBuffer(a) ? `<${a.length} bytes>` : a))).slice(0, 100)}`);
    }
    {
      // Parámetros por canal (fader, mute, trim…): se guarda el último valor de cada canal y su tipo, para conocer la escala.
      const cv = /^\/Input_Channels\/(\d+)\/(.+)$/.exec(m.address);
      if (cv && !/\/name$/.test(m.address) && !/post_meter$/.test(m.address)) {
        if (!this.chVals.has(cv[2]) && this.chVals.size >= 40) { /* demasiados parámetros distintos: se ignora el resto */ }
        else {
          const per = this.chVals.get(cv[2]) || new Map();
          const e = per.get(Number(cv[1])) || { n: 0 };
          per.set(Number(cv[1]), { v: m.args.map((a) => (Buffer.isBuffer(a) ? `<${a.length} bytes>` : a)), tags: m.tags, t: Date.now(), n: e.n + 1 });
          this.chVals.set(cv[2], per);
        }
      }
      const key = m.address.replace(/\/\d+\//g, '/N/');
      const e = this.rx.byAddress.get(key) || { n: 0, sample: '' };
      e.n++;
      if (!e.sample) e.sample = JSON.stringify(m.args.map((a) => (Buffer.isBuffer(a) ? `<${a.length} bytes>` : a))).slice(0, 120);
      this.rx.byAddress.set(key, e);
    }
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
    if (!alive && this.subscribedAt && Date.now() - this.subscribedAt > 30000) { // cada 30 s, no cada 8: no saturar la mesa si no manda medidores
      this.subscribedAt = 0;
      this.count = 0;
      this.handshake();
    }
    // Tres situaciones: llegan medidores; la mesa contesta pero no manda medidores; la mesa no contesta.
    const talking = Date.now() - this.lastAny < 45000; // el saludo se repite cada 30 s: ahí contesta aunque nadie toque nada
    const state = alive ? 'connected' : talking ? 'nometers' : 'lost';
    if (state === this.state) return;
    this.state = state;
    const name = this.consoleName ? `DiGiCo ${this.consoleName}` : 'DiGiCo';
    const p = { name, ip: this.ip, send: this.sendPort, listen: this.listenPort, net: this.netLabel() };
    if (state === 'connected') this.emit('status', { state: 'connected', detail: `${name} (${this.ip})`, key: 'st.connected', p });
    else if (state === 'nometers') this.emit('status', { state: 'connected', detail: `${name} (${this.ip}): conectada, pero la mesa aún no envía medidores`, key: 'st.digicoNoMeters', p });
    else this.emit('status', {
      state: 'lost',
      detail: `Sin respuesta de ${this.ip}. Revisa External Control en la mesa (dispositivo "DiGiCo Pad", puertos ${this.sendPort}/${this.listenPort}).`,
      key: 'st.digicoLost', p,
    });
  }

  // Prueba de medidores sueltos: pide cada medidor por separado, repetidamente durante unos 8 s, y anota los valores.
  // Si cambian con la señal, se puede seguir el nivel consultando cada canal (/diagnostico?medidor=7).
  async probeMeters(ch = 7) {
    const n = Math.min(Math.max(Math.round(ch) || 7, 1), this.count || 48);
    const paths = [
      `/Input_Channels/${n}/Channel_Input/pre_meter/left`,
      `/Input_Channels/${n}/Channel_Input/post_meter/left`,
      `/Input_Channels/${n}/fader_meter/left`,
      `/Input_Channels/${n}/Dynamics/input_meter/left`,
      `/Input_Channels/${n}/Output/meter/left`,
    ];
    this.meterProbe = { series: new Map(paths.map((p) => [p, []])), other: 0 };
    const t0 = Date.now();
    for (let round = 0; round < 16; round++) {
      for (const p of paths) { this.send(`${p}/?`); await new Promise((r) => setTimeout(r, 30)); }
      await new Promise((r) => setTimeout(r, 350));
    }
    await new Promise((r) => setTimeout(r, 500));
    const probe = this.meterProbe; this.meterProbe = null;
    const out = [`PRUEBA DE MEDIDORES SUELTOS (canal ${n}). 16 rondas en ${Math.round((Date.now() - t0) / 1000)} s; cambia el nivel de la señal durante la prueba.`, ''];
    for (const [p, vals] of probe.series) {
      const flat = vals.map((v) => (v.length === 1 ? v[0] : JSON.stringify(v)));
      out.push(`${p}/?`);
      out.push(`    respuestas: ${vals.length}   valores distintos: ${[...new Set(flat.map(String))].length}`);
      out.push(`    serie: ${flat.join(' ')}`);
    }
    out.push('');
    out.push(`Otros paquetes durante la prueba (descargas del canal, cambios de parámetros…): ${probe.other}`);
    out.push('');
    return out.join('\n');
  }

  // Prueba de medidores: manda varias formas posibles de pedirlos (todas de lectura) y anota qué contesta la mesa.
  // Se lanza desde /diagnostico?probar=1&canal=7, con señal en ese canal.
  async probe(ch = 7) {
    const n = Math.min(Math.max(Math.round(ch) || 7, 1), this.count || 48);
    const base = `/Input_Channels/${n}/Channel_Input`;
    const cands = [
      ['consulta  …/post_meter/?', `${base}/post_meter/?`, []],
      ['consulta  …/pre_meter/?', `${base}/pre_meter/?`, []],
      ['post_meter sin argumentos', `${base}/post_meter`, []],
      [`post_meter con (canal, 1)  [el que usa la app]`, `${base}/post_meter`, [n, 1]],
      ['post_meter con (1)', `${base}/post_meter`, [1]],
      ['post_meter con (1.0 decimal)', `${base}/post_meter`, [osc.float(1)]],
      ['pre_meter con (canal, 1)', `${base}/pre_meter`, [n, 1]],
      [`/Meters/request/${n} sin argumentos`, `/Meters/request/${n}`, []],
      ['/Meters/request/1 con la ruta del medidor', '/Meters/request/1', [`${base}/post_meter`]],
      ['/Meters/request/1 con (canal)', '/Meters/request/1', [n]],
      ['salida Aux 1: consulta …/Buss_Trim/post_meter/?', '/Aux_Outputs/1/Buss_Trim/post_meter/?', []],
    ];
    const out = [`PRUEBA DE MEDIDORES (canal ${n}; con señal en ese canal). Todas las peticiones son de lectura.`,
      'Nota: los mensajes de fader, mute o trim que aparezcan sueltos son cambios hechos en la mesa durante la prueba, no respuestas.', ''];
    for (const [label, addr, args] of cands) {
      this.probeLog = { items: [] };
      this.send(addr, args);
      await new Promise((r) => setTimeout(r, 600));
      const items = this.probeLog.items;
      this.probeLog = null;
      out.push(`▶ ${label}`);
      out.push(`    envío: ${addr} ${JSON.stringify(args.map((a) => (a && a.osc ? `${a.v} (float)` : a)))}`);
      if (!items.length) out.push('    respuesta: ninguna');
      else items.forEach((it) => out.push(`    respuesta: ${it}`));
    }
    out.push('');
    return out.join('\n');
  }

  // Texto para ver qué pasa con la mesa (se abre desde la app en /diagnostico).
  diagnostics() {
    const L = [];
    const ago = (t) => (t ? `hace ${Math.round((Date.now() - t) / 1000)} s` : 'nunca');
    L.push('DIAGNÓSTICO DiGiCo');
    L.push('(Para probar formas de pedir los medidores: /diagnostico?probar=1&canal=7, con señal en ese canal)');
    L.push(`IP de la mesa: ${this.ip}`);
    L.push(`La app ENVÍA al puerto ${this.sendPort} de la mesa (en la mesa: "Receive" = ${this.sendPort})`);
    L.push(`La app ESCUCHA en el puerto ${this.listenPort} (en la mesa: "Send" = ${this.listenPort})`);
    let bound = 'no';
    try { const a = this.sock.address(); bound = `sí, en ${a.address}:${a.port}`; } catch {}
    L.push(`Adaptador elegido: ${this.nic ? `${this.nic} (${this.localRoute || 'no disponible'})` : 'automático (lo decide el sistema)'}`);
    L.push(`Puerto de escucha abierto: ${bound}`);
    // Con varios adaptadores, qué dirección de este ordenador usa el sistema para llegar a la mesa.
    L.push(`Dirección de este ordenador para llegar a la mesa: ${this.localRoute || 'no se pudo determinar'}${this.localRoute ? '  (la mesa debe enviar a ESTA dirección)' : ''}`);
    const ips = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) ips.push(`${name} ${a.address}`);
    L.push(`Adaptadores de este ordenador: ${ips.join(' | ') || 'ninguno'}`);
    L.push(`Canales detectados: ${this.count || 'aún no (se usará ' + this.fallbackCount + ' si la mesa no los dice)'}`);
    L.push('');
    L.push(`ENVIADO a la mesa: ${this.tx.total} paquetes`);
    for (const [a, n] of this.tx.byAddress) L.push(`  ${String(n).padStart(5)} × ${a}`);
    if (this.tx.errors.length) { L.push('  Errores al enviar:'); this.tx.errors.forEach((e) => L.push(`    ${e}`)); }
    L.push('');
    L.push(`RECIBIDO de la mesa: ${this.rx.total} mensajes (el último: ${ago(this.rx.last)})${this.rx.bundles ? `; llegaron en ${this.rx.bundles} paquetes "bundle" (Bundles activado en la mesa)` : ''}`);
    for (const [s, n] of this.rx.bySource) L.push(`  desde ${s}: ${n}`);
    for (const [a, e] of this.rx.byAddress) L.push(`  ${String(e.n).padStart(5)} × ${a}   ej: ${e.sample}`);
    if (this.chVals.size) {
      L.push('');
      L.push('ÚLTIMO VALOR DE CADA CANAL (los 12 más recientes por parámetro; entre corchetes el tipo OSC: f = decimal, i = entero, s = texto)');
      for (const [param, per] of this.chVals) {
        const rows = [...per.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, 12);
        const tags = [...new Set(rows.map(([, e]) => e.tags))].map((x) => `,${x}`).join(' ');
        L.push(`  ${param}  [${tags}]`);
        for (const [ch, e] of rows) L.push(`     canal ${String(ch).padStart(2)}: ${JSON.stringify(e.v)}   (${e.n} cambios, ${Math.round((Date.now() - e.t) / 1000)} s)`);
      }
    }
    if (this.rx.bad.length) { L.push('  Paquetes que no son OSC (primeros bytes en hexadecimal):'); this.rx.bad.forEach((b) => L.push(`    ${b}`)); }
    L.push('');
    L.push('QUÉ SIGNIFICA');
    if (!this.rx.total) {
      L.push('  No ha llegado NADA de la mesa. Causas habituales, por orden:');
      L.push('  1. La mesa no envía a este ordenador: en External Control, la IP de destino debe ser la "Dirección de este ordenador" de arriba.');
      L.push(`  2. Puertos: en la mesa, Send = ${this.listenPort} y Receive = ${this.sendPort}. Si son otros, cámbialos aquí en la pantalla de conexión.`);
      L.push('  3. Falta cargar en la mesa el conjunto de comandos de iPad, o el dispositivo no es de tipo "DiGiCo Pad", o hay un iPad conectado.');
      L.push(`  4. El cortafuegos del ordenador bloquea el puerto UDP ${this.listenPort} de entrada.`);
    } else if (this.rx.bySource.size && ![...this.rx.bySource.keys()].some((s) => s.startsWith(`${this.ip}:`))) {
      L.push(`  Llegan paquetes, pero NO desde la IP ${this.ip} que has indicado: mira "desde" arriba y usa esa IP.`);
    } else if (!this.rx.byAddress.has('/Meters/values')) {
      L.push('  La mesa contesta, pero no envía medidores. Falta suscribirse o el protocolo de tu modelo difiere: envíame este texto.');
    } else {
      L.push('  La mesa envía medidores. Si no ves niveles, envíame este texto (puede ser la escala de los valores).');
    }
    return L.join('\n');
  }

  stop() {
    this.timers.forEach(clearInterval);
    clearTimeout(this.countTimer);
    clearTimeout(this.retryStart);
    clearTimeout(this.ctlTimer);
    clearTimeout(this.flushTimer);
    try { if (this.sock) this.sock.close(); } catch {}
  }
}

module.exports = DiGiCo;

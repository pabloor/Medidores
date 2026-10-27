// Driver EXPERIMENTAL para DiGiCo SD, Quantum y S21/S31.
//
// MEDIDORES (verificado capturando la app oficial de DiGiCo con una Quantum, conjunto de comandos iPad_q1):
//   La app manda /Meters/clear y, por cada canal i (0, 1, 2…):
//        /Meters/request/i  ,s  "/Input_Channels/<i+1>/Channel_Input/post_meter/left"
//   La mesa responde con /Meters/values ,ii…  → pares (i, valor). El valor es un entero que empaqueta dos números de 16 bits:
//        mitad alta = pico retenido, mitad baja = nivel actual, ambos en "−dB" (27 = −27 dB). 126 (0x7E) = silencio.
//   La escala en dB no está calibrada contra un nivel de referencia: compárala con el medidor de la mesa.
//
// Protocolo anterior (suposición de la comunidad, que no funciona en una Quantum):
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
    this.meterSeen = false; // ¿ha llegado algún medidor desde que se conectó?
    this.resubs = 0;        // cuántas veces se ha renovado la suscripción de medidores
    this.meterMode = 'level'; // qué mitad del valor de la mesa se muestra: level (baja), peak (alta) o max (la mayor de las dos)
    this.fall = 26;           // caída del medidor en la app, en dB/s (la app usa 26 para todas las mesas)
    this.series = null;       // grabación de una serie de medidores para el diagnóstico
    this.lastPacked = [];     // último valor crudo recibido de cada tira: { hi, lo, t }
    // Diagnóstico: qué se ha enviado a la mesa y qué ha llegado (se consulta en /diagnostico).
    this.startedAt = Date.now();
    this.tx = { total: 0, byAddress: new Map(), errors: [] };
    this.rx = { total: 0, bundles: 0, bySource: new Map(), byAddress: new Map(), bad: [], last: 0 };
    this.out = { aux: 0, grp: 0, mtx: 0, cg: 0 }; // salidas y grupos de control (VCA) que dice tener la mesa
    this.vcaNames = {};
    this.busVals = []; this.mtxVals = []; this.outNames = { aux: {}, grp: {}, mtx: {} };
    this.cs = null;        // control: { ch, bus, mtx } con [{ fader, on, gain }] por tira
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
    this.timers.push(setInterval(() => { if (this.sock && this.count) this.send('/Console/Name/?'); }, 2500)); // aviso de vida: la mesa contesta aunque nadie toque nada
  }

  send(address, args = []) {
    const key = address.replace(/\/\d+(?=\/|$)/g, '/N'); // los canales se agrupan: /Input_Channels/N/…
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
    this.syncOutputs();
    this.emitLayout();
    this.subscribe();
    this.scheduleControl();
  }

  // ---- Salidas: la mesa dice cuántas auxiliares, grupos y matrices tiene (/Console/Aux_Outputs, Group_Outputs, Matrix_Outputs).
  // En el control se agrupan así: "bus" = auxiliares + grupos (en las DiGiCo el master es un grupo), "mtx" = matrices de salida.
  setOutCount(kind, n) {
    if (!Number.isInteger(n) || n < 0 || n > 64 || this.out[kind] === n) return;
    this.out[kind] = n;
    if (kind === 'cg') { if (this.count) this.scheduleControl(); return; } // los VCA solo se controlan: no tienen medidor
    if (!this.count) return; // se aplicará al conocer los canales de entrada
    this.syncOutputs();
    this.emitLayout();
    this.subscribe(true);
    this.scheduleControl();
  }
  nBus() { return this.out.aux + this.out.grp; }
  syncOutputs() {
    const fit = (arr, n) => { const out = new Array(n).fill(-90); for (let i = 0; i < Math.min(n, arr.length); i++) out[i] = arr[i]; return out; };
    this.busVals = fit(this.busVals, this.nBus());
    this.mtxVals = fit(this.mtxVals, this.out.mtx);
  }
  // Ruta base de una tira: /Input_Channels/N, /Aux_Outputs/N, /Group_Outputs/N o /Matrix_Outputs/N.
  stripBase(g, i) {
    if (g === 'ch') return `/Input_Channels/${i + 1}`;
    if (g === 'mtx') return `/Matrix_Outputs/${i + 1}`;
    if (g === 'vca') return `/Control_Groups/${i + 1}`; // grupos de control (VCA)
    return i < this.out.aux ? `/Aux_Outputs/${i + 1}` : `/Group_Outputs/${i - this.out.aux + 1}`;
  }
  meterPath(g, i) { return g === 'ch' ? `${this.stripBase(g, i)}/Channel_Input/post_meter/left` : `${this.stripBase(g, i)}/Buss_Trim/post_meter/left`; }
  namePath(g, i) { return g === 'ch' ? `${this.stripBase(g, i)}/Channel_Input/name` : `${this.stripBase(g, i)}/Buss_Trim/name`; }

  // ---- Control: fader (dB), ON (= no mute) y, en las entradas, ganancia del previo (analog_gain, dB).
  // Escalas según la documentación de la comunidad y las respuestas de una Quantum:
  //   <tira>/fader                                 float dB, -150 (−∞) … +10
  //   <tira>/mute                                  float 0/1 (1 = silenciado)
  //   /Input_Channels/N/Channel_Input/analog_gain  float dB, -20 … +60
  // Entradas verificadas con una Quantum; buses (auxiliares y grupos) y matrices siguen el mismo esquema según la tabla de comandos.
  scheduleControl() {
    clearTimeout(this.ctlInitTimer);
    this.ctlInitTimer = setTimeout(() => this.initControl(), 400); // deja que lleguen los números de salidas antes de pedir el estado
  }

  initControl() {
    const nb = this.nBus(), nm = this.out.mtx, nv = this.out.cg;
    if (this.cs && this.cs.ch.length === this.count && this.cs.bus.length === nb && this.cs.mtx.length === nm && this.cs.vca.length === nv) return; // el saludo se repite: no reiniciar el estado
    clearTimeout(this.ctlTimer);
    this.ctlReady = false;
    const mk = (n) => Array.from({ length: n }, () => ({ fader: null, on: null, gain: null }));
    this.cs = { ch: mk(this.count), bus: mk(nb), mtx: mk(nm), vca: mk(nv) };
    let slot = 0;
    for (const [g, n] of [['ch', this.count], ['bus', nb], ['mtx', nm], ['vca', nv]]) {
      for (let i = 0; i < n; i++) {
        const base = this.stripBase(g, i);
        setTimeout(() => {
          this.send(`${base}/fader/?`);
          this.send(`${base}/mute/?`);
          if (g === 'ch') this.send(`${base}/Channel_Input/analog_gain/?`);
          if (g === 'vca') this.send(`${base}/name/?`);
        }, 150 + (slot++) * 15);
      }
    }
    // Se publica lo que haya contestado la mesa; lo que falte llega después como cambios sueltos.
    this.ctlTimer = setTimeout(() => { this.ctlReady = true; this.emit('control', this.encodeControl()); }, 150 + slot * 15 + 1500);
  }

  encodeControl() {
    const map = (arr) => arr.map((c) => ({ fader: c.fader, on: c.on, gain: c.gain, link: 0, stereo: false, pair: -1 }));
    // Los VCA llevan su número y nombre en la propia tira (no tienen medidor ni están en el layout de medidores).
    const vca = this.cs.vca.map((c, i) => ({ fader: c.fader, on: c.on, gain: null, link: 0, stereo: false, pair: -1, num: `V${i + 1}`, name: this.vcaNames[i + 1] || '' }));
    return { caps: { gain: { min: -20, max: 60, step: 0.5 }, faderMax: 10, mainNames: ['Stereo'], vcaName: 'VCA' }, ch: map(this.cs.ch), main: [], bus: map(this.cs.bus), mtx: map(this.cs.mtx), vca };
  }

  ctlUpdate(g, i, param, v) {
    const c = this.cs && this.cs[g] && this.cs[g][i];
    if (!c) return;
    let key, val;
    if (param === 'fader') { key = 'fader'; val = v <= -90 ? -Infinity : Math.round(v * 10) / 10; }
    else if (param === 'mute') { key = 'on'; val = v < 0.5; }
    else { key = 'gain'; val = Math.round(v * 10) / 10; }
    if (c[key] === val) return;
    c[key] = val;
    if (this.ctlReady) this.emit('param', { g, i, key, value: val });
  }

  // Petición desde la app. Devuelve el valor ya ajustado o undefined si no se puede.
  set(g, i, key, value) {
    const c = this.cs && this.ctlReady && this.cs[g] && this.cs[g][i];
    if (!c) return undefined;
    const base = this.stripBase(g, i);
    let addr, arg, out;
    if (key === 'fader') {
      const db = value === -Infinity || value == null || value <= -90 ? -150 : Math.min(10, Math.max(-150, Number(value)));
      addr = `${base}/fader`; arg = osc.float(db); out = db <= -90 ? -Infinity : Math.round(db * 10) / 10;
    } else if (key === 'on') {
      addr = `${base}/mute`; arg = osc.float(value ? 0 : 1); out = !!value;
    } else if (key === 'gain' && g === 'ch' && c.gain != null) {
      const db = Math.min(60, Math.max(-20, Math.round(Number(value) * 2) / 2)); // pasos de 0,5 dB
      addr = `${base}/Channel_Input/analog_gain`; arg = osc.float(db); out = db;
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

  // refresh = true: renueva la suscripción sin tocar el estado (niveles, canales, "medidores vistos").
  // Los medidores se piden con un número (id) por tira: 0..canales-1 las entradas, luego los buses y luego las matrices.
  subscribe(refresh = false) {
    if (refresh) this.resubs++; else this.meterSeen = false;
    this.send('/Meters/clear');
    let id = 0, slot = 0;
    for (const [g, n] of [['ch', this.count], ['bus', this.nBus()], ['mtx', this.out.mtx]]) {
      for (let i = 0; i < n; i++, id++) {
        const myId = id, path = this.meterPath(g, i), name = this.namePath(g, i);
        setTimeout(() => {
          this.send(`/Meters/request/${myId}`, [path]);
          this.send(`${name}/?`);
        }, 20 + (++slot) * 8); // espaciado: se sabe que las SD pierden ráfagas
      }
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
      const key = um.address.replace(/\/\d+(?=\/|$)/g, '/N');
      const e = this.rx.byAddress.get(key) || { n: 0, sample: '' };
      e.n++;
      if (!e.sample) e.sample = `(sin etiquetas) ${JSON.stringify(um.floats.map((f) => Math.round(f * 1000) / 1000))}`;
      this.rx.byAddress.set(key, e);
      if (this.probeLog && this.probeLog.items.length < 8) this.probeLog.items.push(`${um.address}  (medidor sin etiquetas) ${JSON.stringify(um.floats.map((f) => Math.round(f * 1000) / 1000))}`);
      // Medidor de un canal de entrada: /Input_Channels/N/…meter → el primer float es el nivel.
      const cm = /^\/Input_Channels\/(\d+)\/.*(post|pre)_meter$/i.exec(um.address);
      if (cm && this.count && um.floats.length) {
        const i = Number(cm[1]);
        if (i >= 1 && i <= this.count) { this.lastRx = Date.now(); this.values[i - 1] = Math.max(-90, Math.min(20, this.toDb(um.floats[0]))); this.emitLevels(); }
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
      const cm = /^\/(Input_Channels|Aux_Outputs|Group_Outputs|Matrix_Outputs|Control_Groups)\/(\d+)\/(fader|mute|Channel_Input\/analog_gain)$/.exec(m.address);
      if (cm && typeof m.args[0] === 'number') {
        const n = Number(cm[2]) - 1, param = cm[3] === 'fader' ? 'fader' : cm[3] === 'mute' ? 'mute' : 'gain';
        if (cm[1] === 'Input_Channels') this.ctlUpdate('ch', n, param, m.args[0]);
        else if (param !== 'gain') this.ctlUpdate(cm[1] === 'Control_Groups' ? 'vca' : cm[1] === 'Matrix_Outputs' ? 'mtx' : 'bus', cm[1] === 'Group_Outputs' ? this.out.aux + n : n, param, m.args[0]);
      }
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
      const key = m.address.replace(/\/\d+(?=\/|$)/g, '/N');
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
    const oc = /^\/Console\/(Aux_Outputs|Group_Outputs|Matrix_Outputs|Control_Groups)$/.exec(m.address);
    if (oc && Number.isInteger(m.args[0])) return this.setOutCount(oc[1] === 'Aux_Outputs' ? 'aux' : oc[1] === 'Group_Outputs' ? 'grp' : oc[1] === 'Matrix_Outputs' ? 'mtx' : 'cg', m.args[0]);
    const vn = /^\/Control_Groups\/(\d+)\/name$/.exec(m.address);
    if (vn && typeof m.args[0] === 'string') {
      this.vcaNames[vn[1]] = m.args[0];
      clearTimeout(this.vcaNameTimer); // los nombres llegan de uno en uno: se vuelve a publicar el control cuando han llegado
      this.vcaNameTimer = setTimeout(() => { if (this.ctlReady && this.cs) this.emit('control', this.encodeControl()); }, 400);
      return;
    }
    const on = /^\/(Aux_Outputs|Group_Outputs|Matrix_Outputs)\/(\d+)\/Buss_Trim\/name$/.exec(m.address);
    if (on && typeof m.args[0] === 'string') {
      this.outNames[on[1] === 'Aux_Outputs' ? 'aux' : on[1] === 'Group_Outputs' ? 'grp' : 'mtx'][on[2]] = m.args[0];
      clearTimeout(this.layoutTimer);
      this.layoutTimer = setTimeout(() => this.emitLayout(), 300);
      return;
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

  // /Meters/values: pares (tira 0-based, valor). El valor empaqueta dos enteros de 16 bits: pico retenido (alta) y nivel (baja), en −dB.
  // Numeración de las tiras: entradas, luego buses (auxiliares y grupos), luego matrices.
  onMeters(args) {
    if (!this.count) return;
    this.lastRx = Date.now();
    this.meterSeen = true;
    this.raw = this.raw || { '/Meters/values': [] };
    const nb = this.nBus(), nm = this.out.mtx;
    if (this.series) this.series.msgs++;
    for (let k = 0; k + 1 < args.length; k += 2) {
      const id = Number(args[k]), v = Number(args[k + 1]);
      if (!Number.isInteger(id) || !Number.isFinite(v) || id < 0) continue;
      const lo = v & 0xffff, hi = (v >>> 16) & 0xffff;
      this.lastPacked[id] = { hi, lo, t: Date.now() };
      if (this.series) this.series.ids.add(id);
      if (this.series && id === this.series.id) this.series.rows.push([Date.now() - this.series.t0, hi, lo, v]);
      const m = this.meterMode === 'peak' ? hi : this.meterMode === 'max' ? Math.min(hi, lo) : lo;
      const db = -m;
      const val = Math.max(-90, Math.min(20, db));
      if (id < this.count) this.values[id] = val;
      else if (id < this.count + nb) this.busVals[id - this.count] = val;
      else if (id < this.count + nb + nm) this.mtxVals[id - this.count - nb] = val;
      else continue;
      this.raw['/Meters/values'][id] = db;
    }
    this.emitLevels();
    this.emit('raw', this.raw);
  }

  // Ajustes en directo del medidor (desde /diagnostico?modo=…&caida=…): no se guardan, valen hasta cerrar la app.
  setMeterMode(mode) { if (['level', 'peak', 'max'].includes(mode)) this.meterMode = mode; return this.meterMode; }
  setFall(v) { const n = Number(v); if (Number.isFinite(n) && n >= 5 && n <= 400) { this.fall = n; this.emit('meterFall', n); } return this.fall; }

  // Graba unos segundos los valores que manda la mesa para un canal, para ver su ritmo y cómo se comportan las dos mitades.
  async recordSeries(ch = 7, ms = 12000) {
    const n = Math.min(Math.max(Math.round(ch) || 7, 1), this.count || 48);
    this.series = { id: n - 1, t0: Date.now(), rows: [], msgs: 0, ids: new Set() };
    await new Promise((r) => setTimeout(r, ms));
    const { rows, msgs, ids } = this.series; this.series = null;
    const out = [`SERIE DE MEDIDORES (canal ${n}, ${Math.round(ms / 1000)} s). Cada fila: tiempo (ms), mitad alta, mitad baja; los números son "−dB" (27 = −27 dB).`, ''];
    const last = this.lastPacked[n - 1];
    out.push(`Durante la grabación llegaron ${msgs} mensajes /Meters/values, con valores de ${ids.size} tiras distintas${ids.size ? ` (números de tira: ${[...ids].sort((a, b) => a - b).slice(0, 30).join(', ')}${ids.size > 30 ? '…' : ''})` : ''}.`);
    out.push(`Último valor recibido de este canal: ${last ? `alta ${last.hi}, baja ${last.lo} (hace ${Math.round((Date.now() - last.t) / 1000)} s)` : 'ninguno desde que se conectó'}. Valor que muestra la app ahora: ${this.values[n - 1] ?? '—'} dB.`, '');
    if (!rows.length) return out.concat([
      'No ha llegado NINGÚN valor de este canal en esos segundos: la mesa no ha mandado ningún cambio de su medidor.',
      ids.size ? '(Pero sí de otros canales: la suscripción funciona; este canal no ha cambiado de valor.)' : '(Tampoco de otros canales: puede que la mesa no esté mandando medidores ahora.)']).join('\n');
    const stat = (a) => { const s = [...a].sort((x, y) => x - y); return `mín ${s[0]}  mediana ${s[s.length >> 1]}  máx ${s[s.length - 1]}  distintos ${new Set(a).size}`; };
    const dts = rows.slice(1).map((r, k) => r[0] - rows[k][0]);
    out.push(`Muestras: ${rows.length} (${(rows.length / (ms / 1000)).toFixed(1)} por segundo)`);
    if (dts.length) out.push(`Tiempo entre muestras (ms): ${stat(dts)}`);
    out.push(`Mitad alta: ${stat(rows.map((r) => r[1]))}`);
    out.push(`Mitad baja: ${stat(rows.map((r) => r[2]))}`);
    out.push(`Alta menor que baja (= más fuerte): ${rows.filter((r) => r[1] < r[2]).length} | iguales: ${rows.filter((r) => r[1] === r[2]).length} | alta mayor: ${rows.filter((r) => r[1] > r[2]).length}`);
    out.push(`Valores enteros distintos recibidos (en hexadecimal): ${[...new Set(rows.map((r) => r[3]))].slice(0, 12).map((x) => (x >>> 0).toString(16)).join(' ')}`);
    out.push('', 'tiempo   alta  baja   entero');
    const step = Math.max(1, Math.ceil(rows.length / 140));
    for (let k = 0; k < rows.length; k += step) out.push(`${String(rows[k][0]).padStart(6)}  ${String(rows[k][1]).padStart(4)}  ${String(rows[k][2]).padStart(4)}  ${(rows[k][3] >>> 0).toString(16)}`);
    return out.join('\n');
  }

  // Un grupo de niveles por cada grupo del layout: entradas, buses (si hay) y matrices (si hay).
  emitLevels() {
    const out = [this.values];
    if (this.nBus()) out.push(this.busVals);
    if (this.out.mtx) out.push(this.mtxVals);
    this.emit('levels', out);
  }

  emitLayout() {
    if (!this.count) return;
    const groups = [{
      id: 'ch',
      name: 'Canales',
      strips: Array.from({ length: this.count }, (_, k) => ({ num: `${k + 1}`, name: this.names[k + 1] || '' })),
    }];
    if (this.nBus()) {
      groups.push({
        id: 'bus',
        name: 'Buses',
        strips: Array.from({ length: this.nBus() }, (_, k) => (k < this.out.aux
          ? { num: `A${k + 1}`, name: this.outNames.aux[k + 1] || '' }
          : { num: `G${k - this.out.aux + 1}`, name: this.outNames.grp[k - this.out.aux + 1] || '' })),
      });
    }
    if (this.out.mtx) {
      groups.push({
        id: 'mtx',
        name: 'Matrices',
        strips: Array.from({ length: this.out.mtx }, (_, k) => ({ num: `M${k + 1}`, name: this.outNames.mtx[k + 1] || '' })),
      });
    }
    this.emit('layout', {
      mixer: { name: this.consoleName ? `DiGiCo ${this.consoleName}` : 'DiGiCo', model: this.consoleName || 'DiGiCo', ip: this.ip },
      groups,
    });
  }

  checkAlive() {
    const now = Date.now();
    // La mesa solo envía un medidor cuando cambia: con los canales en silencio puede pasar tiempo sin medidores y la conexión
    // sigue bien. Por eso "la mesa sigue ahí" se mide con cualquier respuesta (el aviso de cada 2,5 s la provoca).
    const talking = now - this.lastAny < 10000;
    if (talking && this.subscribedAt && this.count) {
      // Renovar la suscripción (sin reiniciar nada): periódicamente y si la mesa contesta pero no manda medidores.
      const metersQuiet = !this.meterSeen || now - this.lastRx > 10000;
      if (now - this.subscribedAt > 30000 || (metersQuiet && now - this.subscribedAt > 10000)) this.subscribe(true);
    }
    // La mesa no contesta desde hace 30 s: volver a presentarse desde cero (por si se reinició).
    if (!talking && this.subscribedAt && now - this.subscribedAt > 30000) {
      this.subscribedAt = 0;
      this.count = 0;
      this.handshake();
    }
    // Tres situaciones: la mesa contesta y hay medidores; contesta pero aún no ha mandado ninguno; no contesta.
    const state = !talking ? 'lost' : this.meterSeen ? 'connected' : 'nometers';
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
    L.push(`Ajustes del medidor: modo ${this.meterMode}, caída ${this.fall} dB/s (cambiar: /diagnostico?modo=level|peak|max&caida=26; grabar: /diagnostico?serie=7)`);
    L.push(`Medidores: ${this.meterSeen ? 'llegan' : 'aún no han llegado'} (último ${this.lastRx ? 'hace ' + Math.round((Date.now() - this.lastRx) / 1000) + ' s' : 'nunca'}); suscripción renovada ${this.resubs} veces`);
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
    clearTimeout(this.vcaNameTimer);
    try { if (this.sock) this.sock.close(); } catch {}
  }
}

module.exports = DiGiCo;

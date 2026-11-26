// Mesa simulada: genera niveles realistas para probar la app sin hardware.
const EventEmitter = require('events');

const CH = ['Bombo', 'Caja', 'Hi-hat', 'Tom 1', 'Tom 2', 'Base', 'OH L', 'OH R', 'Bajo DI', 'Bajo mic',
  'Guit 1', 'Guit 2', 'Teclas L', 'Teclas R', 'Acúst.', 'Voz', 'Coro 1', 'Coro 2', 'Presen.', 'PC L', 'PC R', 'Talk'];
const BUS = ['Mon 1', 'Mon 2', 'Mon 3', 'Mon 4', 'IEM L', 'IEM R', 'Sub', 'Rev'];

// Colores de tira, como los que pone el técnico en la mesa (batería roja, bajo amarillo, guitarras verdes…)
const CH_COLOR = ['#e5534b', '#e5534b', '#e5534b', '#e5534b', '#e5534b', '#e5534b', '#e5534b', '#e5534b', '#e0b43a', '#e0b43a',
  '#57ab5a', '#57ab5a', '#539bf5', '#539bf5', '#57ab5a', '#e275ad', '#e275ad', '#e275ad', '#986ee2', '#76e3ea', '#76e3ea', '#8a93a3'];
const BUS_COLOR = ['#f0883e', '#f0883e', '#f0883e', '#f0883e', '#986ee2', '#986ee2', '#8a93a3', '#8a93a3'];
const SEND_BUSES = 6; // Mon 1-4 e IEM L/R son auxiliares (tienen envíos); Sub y Rev, no
const SCENES = ['Prueba de sonido', 'Intro', 'Canción 1', 'Canción 2 · balada', 'Canción 3', 'Bis'];
// Canales con compresor (reducción según el nivel) y con puerta (cierra en silencio)
const COMP = { Bombo: -18, Caja: -16, 'Bajo DI': -20, 'Bajo mic': -20, Voz: -22, 'Coro 1': -20, 'Coro 2': -20, 'Acúst.': -18 };
const GATE = new Set(['Bombo', 'Caja', 'Tom 1', 'Tom 2', 'Base']);

const frac = (x) => x - Math.floor(x);
const noise = () => (Math.random() - 0.5) * 2;

class Simulator extends EventEmitter {
  start() {
    this.emit('layout', {
      mixer: { name: 'Simulador', model: 'Simulador', ip: 'local' },
      groups: [
        { id: 'ch', name: 'Canales', strips: CH.map((n, i) => ({ num: String(i + 1), name: n, color: CH_COLOR[i] })) },
        { id: 'bus', name: 'Buses', strips: BUS.map((n, i) => ({ num: `B${i + 1}`, name: n, color: BUS_COLOR[i] })) },
        { id: 'main', name: 'Main', strips: [{ num: 'L', name: '' }, { num: 'R', name: '' }] },
      ],
    });
    this.emit('status', { state: 'connected', detail: 'Simulador (sin mesa conectada)', key: 'st.sim' });

    // Control simulado: fader, ON y previo de cada tira, y los envíos de cada canal a los auxiliares
    const strip = (fader, gain = null) => ({ fader, on: true, gain, link: 0, stereo: false, pair: -1 });
    this.cs = { ch: CH.map((n, i) => strip(n === 'Talk' ? -Infinity : -5 + (i % 4) * 2, 24 + (i % 5) * 4)), bus: BUS.map(() => strip(0)), main: [strip(0), strip(0)], mtx: [], vca: [] };
    this.cs.ch[6].pair = 7; this.cs.ch[7].pair = 6; this.cs.ch[12].pair = 13; this.cs.ch[13].pair = 12; // OH y Teclas en estéreo
    this.sends = Array.from({ length: SEND_BUSES }, (_, b) => CH.map((n, i) => ({ level: (i + b) % 3 === 0 ? -Infinity : -10 + ((i * 7 + b * 3) % 15), on: true })));
    this.emit('control', this.encodeControl());
    this.scene = 0;
    this.emit('scene', { num: 1, name: SCENES[0] });
    this.sceneTimer = setInterval(() => { this.scene = (this.scene + 1) % SCENES.length; this.emit('scene', { num: this.scene + 1, name: SCENES[this.scene] }); }, 45000);

    const t0 = Date.now();
    let tick = 0;
    this.timer = setInterval(() => {
      const t = (Date.now() - t0) / 1000;
      const beat = t * 2; // 120 bpm
      const hit = (phase, decay) => Math.exp(-frac(phase) * decay);
      const song = 0.5 + 0.5 * Math.sin(t / 9); // intensidad que sube y baja
      if (process.env.SIM_LINECHECK) { const lv = this.lineCheckLevels(t); this.lastBus = lv[1]; return this.emit('levels', lv); }
      const ch = CH.map((name, i) => {
        if (name === 'Talk') return -90;
        if (name === 'Bombo') return -42 + 38 * hit(beat, 9) + noise();
        if (name === 'Caja') return -45 + 40 * hit((beat + 1) / 2, 7) + noise();
        if (name === 'Hi-hat') return -34 + 16 * hit(beat * 2, 12) + noise();
        if (name.startsWith('Tom')) return frac(t / 8) > 0.85 ? -30 + 24 * hit(beat * 2, 6) : -60 + noise() * 3;
        if (name === 'Voz') return frac(t / 12) < 0.7 ? -14 + 10 * song + 4 * Math.sin(t * 5) + noise() * 2 : -58;
        return -24 + 8 * song + 5 * Math.sin(t * 0.7 + i) + noise() * 2;
      });
      const mix = Math.max(...ch.slice(0, 16)) - 6;
      const bus = BUS.map((_, i) => mix - 4 - i + noise() * 1.5);
      const main = [mix - 1 + noise(), mix - 1.5 + noise()];
      this.emit('levels', [ch, bus, main].map((g) => g.map((v) => Math.min(0, v))));
      // Reducción de ganancia (dB, positiva): compresor por encima de su umbral, puerta cerrada en silencio
      if (++tick % 3 === 0) {
        this.emit('gr', {
          comp: CH.map((n, i) => (COMP[n] != null && ch[i] > COMP[n] ? Math.min(18, (ch[i] - COMP[n]) * 0.7) : 0)),
          gate: CH.map((n, i) => (GATE.has(n) && ch[i] < -42 ? 40 : 0)),
        });
      }
    }, 33);
  }

  encodeControl() {
    return { caps: { gain: { min: -6, max: 66, step: 1 }, faderMax: 10, mainNames: ['Stereo'], sends: true, sendBuses: SEND_BUSES }, ...this.cs };
  }
  set(g, i, key, value) {
    const c = this.cs && this.cs[g] && this.cs[g][i];
    if (!c || !['fader', 'on', 'gain'].includes(key)) return undefined;
    if (key === 'fader') value = value === -Infinity || value <= -90 ? -Infinity : Math.min(10, Math.round(value * 10) / 10);
    else if (key === 'gain') { if (c.gain == null) return undefined; value = Math.min(66, Math.max(-6, Math.round(value))); }
    else value = !!value;
    c[key] = value;
    return value;
  }
  // Envíos de los canales a un auxiliar (mezcla de monitores): null si ese bus no tiene envíos
  sendsOf(bus) { return this.sends && this.sends[bus] ? this.sends[bus].map((s) => ({ ...s })) : null; }
  watchSends() {} // el simulador ya los tiene todos
  setSend(bus, i, key, value) {
    const s = this.sends && this.sends[bus] && this.sends[bus][i];
    if (!s || !['level', 'on'].includes(key)) return undefined;
    s[key] = key === 'on' ? !!value : value === -Infinity || value <= -90 ? -Infinity : Math.min(10, Math.round(value * 10) / 10);
    return s[key];
  }

  // SIM_LINECHECK=1: simula un line check con fallos a propósito.
  // Con el line check guiado en marcha, hace de técnico de escenario: el servidor le dice qué tiras tocan (lineCheckCue)
  // y, un segundo después, les da señal durante unos segundos. La primera vez que se pide cada una reproduce su fallo;
  // la segunda ya está "arreglado" (así se ve que el guiado vuelve a los pendientes al final):
  //   5 Tom 2 entra por 6 Base (cruce) · 14 Teclas R entra por 15 Acúst. (al par le falta un lado)
  //   7 OH L y 8 OH R invertidos (solo se ve comprobando los lados por separado)
  //   con 16 Voz suena también 17 Coro 1 (micro abierto) · el bus Mon 3 sale por Mon 4 (cruce de envíos)
  // Sin line check guiado (o en libre), da señal a un canal y a un bus cada 2,5 s, con los mismos fallos.
  // En los dos casos, 20 PC L y 14 Teclas R tienen un zumbido bajo y constante.
  lineCheckCue(keys) {
    const id = keys.join('|');
    this.lcVisits = this.lcVisits || new Map();
    const n = (this.lcVisits.get(id) || 0) + 1;
    this.lcVisits.set(id, n);
    this.cue = keys.length ? { keys, first: n === 1, at: Date.now() } : null;
  }
  // Emisores de IEM simulados (solo con SIM_LINECHECK): lo que recibe el emisor conectado a un bus es el nivel de ese bus,
  // salvo el de Mon 2, al que la primera vez no le llega nada (cable o Dante), y el lado R de IEM L/R, que la primera vez
  // tampoco llega (al emisor solo le llega un lado). Ver iem.json en el servidor.
  iemInput(key) { // (key, entrada del emisor): el simulador solo necesita el bus
    if (!process.env.SIM_LINECHECK) return null;
    const [g, i] = key.split(':');
    if (g !== 'bus' || !this.lastBus) return null;
    if (key === 'bus:1' && this.cue && this.cue.first && this.cue.keys.includes('bus:1')) return -90;
    if (key === 'bus:5' && this.cue && this.cue.first && this.cue.keys.includes('bus:5')) return -90; // IEM R: no llega al emisor la primera vez
    return this.lastBus[+i] ?? -90;
  }
  // Equipos Shure que "encuentra" la búsqueda en la red (solo con SIM_LINECHECK)
  shureScan() {
    if (!process.env.SIM_LINECHECK) return [];
    return [{ ip: '192.168.0.50', model: 'AD4D', name: 'RX VOCES' }, { ip: '192.168.0.60', model: 'P10T', name: 'IEM RACK A' },
      { ip: '192.168.0.61', model: 'ADTQ', name: 'IEM RACK B' }, { ip: '192.168.0.63', model: 'ADTQ', name: 'IEM RACK C' }];
  }
  // Lo que diría un emisor simulado de su configuración (solo con SIM_LINECHECK). IP acabada en número impar: ADTQ con
  // canales en 2 monos, mono, estéreo y 2 monos; par: P10T con un canal mono y otro estéreo.
  iemDetect(ip) {
    if (!process.env.SIM_LINECHECK) return null;
    const odd = Number(String(ip).split('.').pop()) % 2 === 1;
    if (odd) return { model: 'ADTQ', channels: [{ ch: 1, mode: 'dual', name: 'MON 1 / MON 2' }, { ch: 2, mode: 'mono', name: 'MON 3' }, { ch: 3, mode: 'stereo', name: 'IEM VOZ' }, { ch: 4, mode: 'dual', name: 'MON 4 / SUB' }] };
    return { model: 'P10T', channels: [{ ch: 1, mode: 'mono', name: 'IEM BATERIA' }, { ch: 2, mode: 'stereo', name: 'IEM TECLAS' }] };
  }
  // Tiras que suenan cuando el técnico da señal a `keys` (con su fallo, si es la primera vez)
  lineCheckSounds(keys, first) {
    const out = [];
    for (const k of keys) {
      if (first && k === 'ch:4') out.push(['ch:5', -18]);            // Tom 2 → suena Base
      else if (first && k === 'ch:13') out.push(['ch:14', -18]);     // Teclas R → entra por Acúst.
      else if (first && keys.length === 1 && k === 'ch:6') out.push(['ch:7', -18]); // OH L y R invertidos (pidiendo un solo lado)
      else if (first && keys.length === 1 && k === 'ch:7') out.push(['ch:6', -18]);
      else if (first && k === 'bus:2') out.push(['bus:3', -20]);    // Mon 3 → sale por Mon 4
      else out.push([k, k.startsWith('bus:') ? -20 : -18]);
      if (k === 'ch:15') out.push(['ch:16', -26]);                  // con la Voz, Coro 1 abierto (siempre)
    }
    return out;
  }
  lineCheckLevels(t) {
    const ch = CH.map(() => -90), bus = BUS.map(() => -90);
    const set = ([k, db]) => { const [g, i] = k.split(':'); const a = g === 'ch' ? ch : g === 'bus' ? bus : null; if (a && a[+i] !== undefined) a[+i] = db + noise(); };
    const c = this.cue;
    if (c) { // el técnico espera en silencio a la siguiente indicación
      const dt = (Date.now() - c.at) / 1000;
      if (dt > 1 && dt < 5) this.lineCheckSounds(c.keys, c.first).forEach(set); // 1 s para ir al micro, 4 s de señal
    } else {
      const k = Math.floor(t / 2.5) % CH.length, kb = Math.floor(t / 2.5) % BUS.length;
      this.lineCheckSounds([`ch:${k}`], true).forEach(set);
      if (k === 6 || k === 7) { set(['ch:6', -18]); set(['ch:7', -18]); }      // OH L y OH R a la vez
      if (k === 12 || k === 13) set(['ch:12', -18]);                          // Teclas L sí, Teclas R no
      if (kb === 4 || kb === 5) { set(['bus:4', -20]); set(['bus:5', -21]); }  // IEM L y R a la vez
      else this.lineCheckSounds([`bus:${kb}`], true).forEach(set);
    }
    ch[19] = Math.max(ch[19], -60 + noise() * 0.5); // PC L: zumbido bajo y constante (debajo de la señal, si se la dan)
    ch[13] = Math.max(ch[13], -62 + noise() * 0.5); // Teclas R: también, para ver en qué lado del par está el ruido
    return [ch, bus, [-90, -90]];
  }

  stop() { clearInterval(this.timer); clearInterval(this.sceneTimer); }
}

module.exports = Simulator;

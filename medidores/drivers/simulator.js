// Mesa simulada: genera niveles realistas para probar la app sin hardware.
const EventEmitter = require('events');

const CH = ['Bombo', 'Caja', 'Hi-hat', 'Tom 1', 'Tom 2', 'Base', 'OH L', 'OH R', 'Bajo DI', 'Bajo mic',
  'Guit 1', 'Guit 2', 'Teclas L', 'Teclas R', 'Acúst.', 'Voz', 'Coro 1', 'Coro 2', 'Presen.', 'PC L', 'PC R', 'Talk'];
const BUS = ['Mon 1', 'Mon 2', 'Mon 3', 'Mon 4', 'IEM L', 'IEM R', 'Sub', 'Rev'];

const frac = (x) => x - Math.floor(x);
const noise = () => (Math.random() - 0.5) * 2;

class Simulator extends EventEmitter {
  start() {
    this.emit('layout', {
      mixer: { name: 'Simulador', model: 'Simulador', ip: 'local' },
      groups: [
        { id: 'ch', name: 'Canales', strips: CH.map((n, i) => ({ num: String(i + 1), name: n })) },
        { id: 'bus', name: 'Buses', strips: BUS.map((n, i) => ({ num: `B${i + 1}`, name: n })) },
        { id: 'main', name: 'Main', strips: [{ num: 'L', name: '' }, { num: 'R', name: '' }] },
      ],
    });
    this.emit('status', { state: 'connected', detail: 'Simulador (sin mesa conectada)', key: 'st.sim' });

    const t0 = Date.now();
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
    }, 33);
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
  // salvo el de Mon 2, al que la primera vez no le llega nada (cable o Dante). Ver iem.json en el servidor.
  iemInput(key) {
    if (!process.env.SIM_LINECHECK) return null;
    const [g, i] = key.split(':');
    if (g !== 'bus' || !this.lastBus) return null;
    if (key === 'bus:1' && this.cue && this.cue.first && this.cue.keys.includes('bus:1')) return -90;
    return this.lastBus[+i] ?? -90;
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

  stop() { clearInterval(this.timer); }
}

module.exports = Simulator;

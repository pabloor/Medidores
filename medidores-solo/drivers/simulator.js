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

  stop() { clearInterval(this.timer); }
}

module.exports = Simulator;

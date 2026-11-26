// Estado de los receptores Shure para el panel de inalámbricos: batería, nivel de RF y nombre de cada canal.
// Amplía ShureReceiver (shure.js, que no se toca) con más consultas en la misma conexión TCP 2202. Comandos del protocolo
// publicado por Shure para Axient Digital, ULX-D y QLX-D:
//   < GET 1 BATT_BARS >      -> < REP 1 BATT_BARS 004 >        0-5 rayas; 255 = desconocido (sin petaca)
//   < GET 1 BATT_RUN_TIME >  -> < REP 1 BATT_RUN_TIME 00185 >  minutos que le quedan; 65535/65534 = desconocido o calculando
//   < GET 1 CHAN_NAME >      -> < REP 1 CHAN_NAME {Voz      } >
//   < GET 1 RX_RF_LVL >      -> < REP 1 RX_RF_LVL 080 >        ULX-D/QLX-D: dBm = valor − 128 (SIN VERIFICAR con equipo real)
//   < GET 1 RSSI 1 >         -> < REP 1 RSSI 1 080 >           Axient Digital, por antena: dBm = valor − 120 (SIN VERIFICAR)
// Un modelo que no conozca un comando contesta con un error que se ignora.
const { ShureReceiver } = require('./shure');

const UNKNOWN_BARS = 255;

class ShureStatusReceiver extends ShureReceiver {
  constructor(ip, map, nic) {
    super(ip, map, nic);
    this.stat = {}; // canal del receptor -> { name, bars, mins, rf }
  }

  ask() {
    super.ask();
    for (const ch of Object.keys(this.map)) {
      for (const key of ['BATT_BARS', 'BATT_RUN_TIME', 'CHAN_NAME', 'RX_RF_LVL']) this.send(`GET ${ch} ${key}`);
      this.send(`GET ${ch} RSSI 1`); this.send(`GET ${ch} RSSI 2`);
    }
  }

  onMessage(msg) {
    super.onMessage(msg);
    const m = /^(?:REP|REPORT)\s+(\d)\s+([A-Z_]+)\s+(.*)$/.exec(msg.trim());
    if (!m || !(m[1] in this.map)) return;
    const [, ch, key, rest] = m;
    const s = (this.stat[ch] = this.stat[ch] || { name: '', bars: null, mins: null, rf: null, rssi: {} });
    const num = parseInt(rest, 10);
    let changed = false;
    const put = (k, v) => { if (s[k] !== v) { s[k] = v; changed = true; } };
    if (key === 'BATT_BARS' && Number.isFinite(num)) put('bars', num === UNKNOWN_BARS || num > 5 ? null : num);
    else if (key === 'BATT_RUN_TIME' && Number.isFinite(num)) put('mins', num >= 65534 ? null : num);
    else if (key === 'CHAN_NAME') put('name', rest.replace(/^\{|\}$/g, '').trim());
    else if (key === 'RX_RF_LVL' && Number.isFinite(num)) put('rf', num - 128);
    else if (key === 'RSSI') { // "1 080": antena y valor; se muestra la mejor antena
      const [ant, val] = rest.split(/\s+/).map((x) => parseInt(x, 10));
      if (Number.isFinite(ant) && Number.isFinite(val)) { s.rssi[ant] = val - 120; put('rf', Math.max(...Object.values(s.rssi))); }
    }
    if (changed) this.emit('wstat', { ch, ...s });
  }
}

module.exports = { ShureStatusReceiver };

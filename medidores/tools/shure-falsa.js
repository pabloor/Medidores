// Emula un receptor Shure (AD4D) en TCP 2202 para probar la integración sin equipo.
// Uso: node tools/shure-falsa.js   y en la app: Ajustes → Receptores Shure → IP 127.0.0.1, canal 1 → 25, canal 2 → 26.
// Cada 8 s "alguien" cambia la ganancia del canal 2 en el receptor (para probar la sincronización).
const net = require('net');
const gain = { 1: 30, 2: 28 }; // valor Shure: dB + 18  (30 = +12 dB, 28 = +10 dB)
const clients = new Set();
const rep = (ch) => `< REP ${ch} AUDIO_GAIN ${String(gain[ch]).padStart(3, '0')} >`;
net.createServer((c) => {
  clients.add(c);
  let buf = '';
  c.on('data', (d) => {
    buf += d;
    let end;
    while ((end = buf.indexOf('>')) >= 0) {
      const [cmd, ch, key, val] = buf.slice(0, end).replace('<', '').trim().split(/\s+/);
      buf = buf.slice(end + 1);
      if (key !== 'AUDIO_GAIN' || !(ch in gain)) continue;
      if (cmd === 'SET') { gain[ch] = Math.max(0, Math.min(60, Number(val))); for (const x of clients) x.write(rep(ch)); }
      if (cmd === 'GET') c.write(rep(ch));
    }
  });
  c.on('close', () => clients.delete(c));
  c.on('error', () => {});
}).listen(2202, () => console.log('Receptor Shure falso escuchando en TCP 2202'));
setInterval(() => { gain[2] = gain[2] === 28 ? 31 : 28; for (const x of clients) x.write(rep(2)); }, 8000);

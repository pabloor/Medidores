// Emisor de IEM Shure falso (al estilo de un PSM 1000 P10T, según su manual) para probar sondear-emisor.js sin equipo.
// No reproduce el formato real con seguridad: la escala de AUDIO_IN_LVL_L/R es una suposición. Sirve para probar el script.
// Uso: node tools/shure-pruebas/emisor-falso.js      (TCP 2202; PORT=2203 para otro puerto)
//      y luego: node tools/shure-pruebas/sondear-emisor.js 127.0.0.1 (o 127.0.0.1:2203)
// El canal 1 recibe tono a ratos (izquierda y derecha); el canal 2 solo por la izquierda; el resto, nada.
const net = require('net');
const PORT = Number(process.env.PORT || 2202);
const info = { DEVICE_ID: 'P10T-FALSO', MODEL: 'P10T', FW_VER: '0.0.0', RF_BAND: 'G10' };
const ch = { 1: { CHAN_NAME: 'IEM BATERIA', AUDIO_IN_LVL: '0010', AUDIO_IN_LINE_LVL: '1' }, 2: { CHAN_NAME: 'IEM VOZ', AUDIO_IN_LVL: '0010', AUDIO_IN_LINE_LVL: '1' } };
const level = (c, side, t) => {
  if (c === 1) return Math.sin(t / 2) > 0 ? 30 + Math.round(5 * Math.sin(t * 3)) : 0; // tono a ratos
  if (c === 2 && side === 'L') return 22;
  return 0;
};
net.createServer((sock) => {
  const timers = {};
  const send = (m) => { if (!sock.destroyed) sock.write(`< ${m} >\r\n`); };
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let a, b;
    while ((a = buf.indexOf('<')) >= 0 && (b = buf.indexOf('>', a)) >= 0) {
      const [cmd, x, key, val] = buf.slice(a + 1, b).trim().split(/\s+/);
      buf = buf.slice(b + 1);
      if (cmd === 'GET' && x in info) send(`REPORT ${x} ${info[x]}`);
      else if (cmd === 'GET' && ch[x] && key in ch[x]) send(`REPORT ${x} ${key} ${ch[x][key]}`);
      else if (cmd === 'GET' && ch[x] && key === 'METER_RATE') send(`REPORT ${x} METER_RATE ${timers[x] ? timers[x].ms : '00000'}`);
      else if (cmd === 'SET' && ch[x] && key === 'METER_RATE') {
        clearInterval(timers[x] && timers[x].id); delete timers[x];
        const ms = Number(val);
        send(`REPORT ${x} METER_RATE ${String(ms).padStart(5, '0')}`);
        if (ms > 0) timers[x] = { ms: val, id: setInterval(() => { const t = Date.now() / 1000; for (const s of ['L', 'R']) send(`REPORT ${x} AUDIO_IN_LVL_${s} ${String(level(Number(x), s, t)).padStart(3, '0')}`); }, Math.max(100, ms)) };
      }
    }
  });
  sock.on('close', () => Object.values(timers).forEach((tm) => clearInterval(tm.id)));
  sock.on('error', () => {});
}).listen(PORT, '127.0.0.1', () => console.log(`Emisor Shure falso escuchando en TCP ${PORT}`));

// Prueba: ¿cruzar post_meter y fader_meter del mismo canal da más resolución?
// Valor v de la mesa (mitad baja) = nivel L en (−v−3, −v]. fader_meter mide L + fader_dB.
// Uso: node combinar.js <canal> <segundos>
const dgram = require('dgram');
const osc = require('../../drivers/osc');
const IP = process.env.IP || '192.168.102.121', LOCAL = process.env.LOCAL || undefined; // IP de la mesa; LOCAL = IP del adaptador del Mac (vacío = todos)
const SPORT = Number(process.env.SPORT || 8000), LPORT = Number(process.env.LPORT || 9000); // puertos de la mesa: Receive / Send en External Control
const ch = Number(process.argv[2] || 7), secs = Number(process.argv[3] || 40);
const sock = dgram.createSocket('udp4');
const send = (a, args = []) => sock.send(osc.encode(a, args), SPORT, IP);
let fader = null, p = null, f = null;
const faders = [], events = [], snaps = [];
const t0 = Date.now();
sock.on('message', (b) => {
  let m; try { m = osc.decode(b); } catch { return; }
  if (!m) return;
  if (m.address === `/Input_Channels/${ch}/fader`) { fader = Number(m.args[0]); faders.push([Date.now() - t0, fader]); return; }
  if (m.address !== '/Meters/values') return;
  for (let k = 0; k + 1 < m.args.length; k += 2) {
    const lo = m.args[k + 1] & 0xffff;
    if (m.args[k] === 0 && lo !== p) { p = lo; events.push([Date.now() - t0, 'post', lo]); }
    if (m.args[k] === 1 && lo !== f) { f = lo; events.push([Date.now() - t0, 'fader', lo]); }
  }
});
sock.bind(LPORT, LOCAL, async () => {
  send('/Meters/clear');
  await new Promise((r) => setTimeout(r, 100));
  send(`/Input_Channels/${ch}/fader/?`);
  send('/Meters/request/0', [`/Input_Channels/${ch}/Channel_Input/post_meter/left`]);
  send('/Meters/request/1', [`/Input_Channels/${ch}/fader_meter/left`]);
  const iv = setInterval(() => { if (p != null && f != null && fader != null && p < 100 && f < 100) snaps.push([p, f, fader]); }, 50);
  setInterval(() => send(`/Input_Channels/${ch}/fader/?`), 2000);
  setTimeout(() => {
    clearInterval(iv); send('/Meters/clear');
    console.log('fader leído (dB):', [...new Set(faders.map((x) => x[1].toFixed(2)))].join(', '));
    // diferencia f − p observada (si fader_meter = post + fader exacto, debería ser −fader redondeado a 0 o 3)
    const diff = new Map(), widths = new Map(); let bad = 0;
    for (const [pp, ff, fd] of snaps) {
      diff.set(ff - pp, (diff.get(ff - pp) || 0) + 1);
      const lo = Math.max(-pp - 3, -ff - 3 - fd), hi = Math.min(-pp, -ff - fd); // intervalo de L
      if (hi <= lo) { bad++; continue; }
      const w = (hi - lo).toFixed(2); widths.set(w, (widths.get(w) || 0) + 1);
    }
    console.log(`muestras con señal: ${snaps.length}`);
    console.log('fader_meter − post_meter (en pasos de la mesa):', [...diff].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${d}: ${n}`).join('  '));
    console.log(`incoherentes (intervalos que no se cruzan): ${bad}`);
    console.log('anchura del intervalo resultante (dB):', [...widths].map(([w, n]) => `${w}: ${n}`).join('  '));
    // Orden de los cambios: con el fader a −1,5 los escalones de una y otra deberían alternarse
    console.log('cambios (ms, medidor, valor):');
    console.log(events.slice(0, 400).map(([t, w, v]) => `${t} ${w === 'post' ? 'P' : 'F'}${v}`).join('  '));
    process.exit(0);
  }, secs * 1000);
});

// Canal 7 cerca de 0 dB: qué muestra el driver con y sin volver a pedir los medidores de arriba (pollTop).
// Uso: node probar-arriba.js <ip> <nic> <segundos> [falsa]
const DiGiCo = require('../../drivers/digico');
const [ip, nic, secs, fake] = [process.argv[2], process.argv[3] || '', Number(process.argv[4] || 10), process.argv[5] === 'falsa'];
const level7 = (t) => -2 + 4 * Math.sin(t / 3); // igual que tools/digico-falsa.js con OVER=1
const d = new DiGiCo({ ip, nic, 'listen-port': process.env.LPORT || 9000 });
d.on('status', () => {});
d.start();
const run = (label, ms) => new Promise((res) => {
  const vals = new Map(); let err = 0, n = 0, atTop = 0;
  const iv = setInterval(() => {
    const v = d.values[6]; if (v == null || v <= -90) return;
    const k = v.toFixed(2); vals.set(k, (vals.get(k) || 0) + 1); n++;
    if (v > -1.5) atTop++;
    if (fake) err += Math.abs(v - Math.min(0, level7(Date.now() / 1000)));
  }, 50);
  setTimeout(() => {
    clearInterval(iv);
    const list = [...vals].sort((a, b) => b[0] - a[0]).map(([k, c]) => `${k}(${Math.round((100 * c) / n)}%)`).join(' ');
    console.log(`${label}: trim ${d.trims[6] != null ? d.trims[6].toFixed(2) : '?'} · ${list}`);
    console.log(`   tiempo por encima de −1,5 dB: ${Math.round((100 * atTop) / n)}%${fake ? ` · error medio frente al nivel real: ${(err / n).toFixed(2)} dB` : ''}`);
    res();
  }, ms);
});
setTimeout(async () => {
  await run('volviendo a pedir arriba', secs * 1000);
  const poll = d.pollTop; d.pollTop = () => {};
  await run('sin volver a pedir      ', secs * 1000);
  d.pollTop = poll;
  d.send('/Meters/clear'); setTimeout(() => process.exit(0), 100); // que la mesa deje de mandar medidores al terminar
}, 2500);

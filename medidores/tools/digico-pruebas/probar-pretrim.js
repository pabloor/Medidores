// Mide lo que muestra el driver para el canal 7, con y sin pre_meter + trim.
// Uso: node probar-pretrim.js <ip> <nic> <segundos> [falsa]   (falsa: compara con el nivel real que simula la mesa falsa)
const DiGiCo = require('../../drivers/digico');
const [ip, nic, secs, fake] = [process.argv[2], process.argv[3] || '', Number(process.argv[4] || 10), process.argv[5] === 'falsa'];
const level7 = (t) => -25 + 15 * Math.sin(t / 3); // igual que en tools/digico-falsa.js
const d = new DiGiCo({ ip, nic, 'listen-port': process.env.LPORT || 9000 }); // LPORT=9100 con la mesa falsa en PORT=9100
d.on('status', () => {});
d.start();
const run = (label, ms) => new Promise((res) => {
  const vals = new Map(); let err = 0, errPost = 0, n = 0;
  const iv = setInterval(() => {
    const v = d.values[6]; if (v == null || v <= -90) return;
    const k = v.toFixed(2); vals.set(k, (vals.get(k) || 0) + 1);
    if (fake) { const L = level7(Date.now() / 1000); err += Math.abs(v - L); errPost += Math.abs(-d.postM[6] - L); n++; }
  }, 50);
  setTimeout(() => {
    clearInterval(iv);
    console.log(`${label}: trim ${d.trims[6]} · ${vals.size} valores distintos: ${[...vals.keys()].sort((a, b) => b - a).join(' ')}`);
    if (fake && n) console.log(`   error medio frente al nivel real: ${(err / n).toFixed(2)} dB (solo post_meter: ${(errPost / n).toFixed(2)} dB)`);
    res();
  }, ms);
});
setTimeout(async () => {
  await run('con pre_meter + trim', secs * 1000);
  d.setPreTrim(0); await new Promise((r) => setTimeout(r, 800));
  await run('solo post_meter      ', secs * 1000);
  d.send('/Meters/clear'); setTimeout(() => process.exit(0), 100); // que la mesa deje de mandar medidores al terminar
}, 2500);

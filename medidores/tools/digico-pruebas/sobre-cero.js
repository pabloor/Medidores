// Qué manda la mesa cerca de 0 dB y por encima: valores crudos de post_meter y pre_meter según el trim.
// Uso: node sobre-cero.js <canal> <segundos>
const dgram = require('dgram');
const osc = require('../../drivers/osc');
const IP = process.env.IP || '192.168.102.121', LOCAL = process.env.LOCAL || undefined; // IP de la mesa; LOCAL = IP del adaptador del Mac (vacío = todos)
const ch = Number(process.argv[2] || 7), secs = Number(process.argv[3] || 60);
const sock = dgram.createSocket('udp4');
const send = (a, args = []) => sock.send(osc.encode(a, args), 8000, IP);
const t0 = Date.now();
let trim = null, lastMsg = 0, msgs = 0;
const rows = new Map(); // trim redondeado -> { post: Map(raw->n), pre: Map(raw->n) }
const gaps = [];
const fmt = (v) => { const hi = (v >>> 16) & 0xffff, lo = v & 0xffff; const s = (x) => (x >= 0x8000 ? `${x}(=${x - 0x10000})` : `${x}`); return `${s(hi)}/${s(lo)}${v < 0 ? ' NEG' : ''}`; };
sock.on('message', (b) => {
  let m; try { m = osc.decode(b); } catch { return; }
  if (!m) return;
  if (m.address === `/Input_Channels/${ch}/Channel_Input/trim`) { trim = Number(m.args[0]); return; }
  if (m.address !== '/Meters/values') return;
  const now = Date.now();
  for (let k = 0; k + 1 < m.args.length; k += 2) {
    if (m.args[k] === 0) { msgs++; if (lastMsg && now - lastMsg > 700) gaps.push([((now - t0) / 1000).toFixed(1), ((now - lastMsg) / 1000).toFixed(1), trim]); lastMsg = now; }
    const key = trim == null ? '?' : trim.toFixed(1);
    const r = rows.get(key) || { post: new Map(), pre: new Map() };
    const w = m.args[k] === 0 ? 'post' : 'pre', f = fmt(m.args[k + 1]);
    r[w].set(f, (r[w].get(f) || 0) + 1);
    rows.set(key, r);
  }
});
sock.bind(9000, LOCAL, async () => {
  send('/Meters/clear');
  await new Promise((r) => setTimeout(r, 100));
  send(`/Input_Channels/${ch}/Channel_Input/trim/?`);
  send('/Meters/request/0', [`/Input_Channels/${ch}/Channel_Input/post_meter/left`]);
  send('/Meters/request/1', [`/Input_Channels/${ch}/Channel_Input/pre_meter/left`]);
  setTimeout(() => {
    send('/Meters/clear');
    console.log(`mensajes de post_meter: ${msgs} (${(msgs / secs).toFixed(1)}/s)`);
    console.log('trim (dB) | post_meter pico/nivel (veces) | pre_meter pico/nivel (veces)');
    const list = (mp) => [...mp].map(([k, n]) => `${k}×${n}`).join(' ');
    for (const [t, r] of [...rows].sort((a, b) => Number(a[0]) - Number(b[0]))) console.log(`${t.padStart(5)} | ${list(r.post)} | ${list(r.pre)}`);
    console.log('silencios de post_meter de más de 0,7 s (segundo, duración, trim):', gaps.map((g) => g.join('/')).join('  ') || 'ninguno');
    process.exit(0);
  }, secs * 1000);
});

// Registra pre_meter, post_meter y el trim del canal (tal como lo manda la mesa) para ver su relación.
// Uso: node pre-trim.js <canal> <segundos>   → guarda pre-trim.json (en la carpeta temporal del sistema) con todos los eventos
const dgram = require('dgram');
const fs = require('fs');
const osc = require('../../drivers/osc');
const IP = process.env.IP || '192.168.102.121', LOCAL = process.env.LOCAL || undefined; // IP de la mesa; LOCAL = IP del adaptador del Mac (vacío = todos)
const ch = Number(process.argv[2] || 7), secs = Number(process.argv[3] || 50);
const sock = dgram.createSocket('udp4');
const send = (a, args = []) => sock.send(osc.encode(a, args), 8000, IP);
const t0 = Date.now(), ev = [];
const st = { trim: null, pre: null, post: null, gain: null };
const other = new Map();
sock.on('message', (b) => {
  let m; try { m = osc.decode(b); } catch { return; }
  if (!m) return;
  const t = Date.now() - t0;
  if (m.address === `/Input_Channels/${ch}/Channel_Input/trim`) { st.trim = Number(m.args[0]); ev.push([t, 'trim', st.trim]); return; }
  if (m.address === `/Input_Channels/${ch}/Channel_Input/analog_gain`) { st.gain = Number(m.args[0]); ev.push([t, 'gain', st.gain]); return; }
  if (m.address !== '/Meters/values') { other.set(m.address, (other.get(m.address) || 0) + 1); return; }
  for (let k = 0; k + 1 < m.args.length; k += 2) {
    const lo = m.args[k + 1] & 0xffff, w = m.args[k] === 0 ? 'pre' : 'post';
    if (st[w] !== lo) { st[w] = lo; ev.push([t, w, lo]); }
  }
});
sock.bind(9000, LOCAL, async () => {
  send('/Meters/clear');
  await new Promise((r) => setTimeout(r, 100));
  send(`/Input_Channels/${ch}/Channel_Input/trim/?`);
  send(`/Input_Channels/${ch}/Channel_Input/analog_gain/?`);
  send('/Meters/request/0', [`/Input_Channels/${ch}/Channel_Input/pre_meter/left`]);
  send('/Meters/request/1', [`/Input_Channels/${ch}/Channel_Input/post_meter/left`]);
  setTimeout(() => {
    send('/Meters/clear');
    fs.writeFileSync(require('os').tmpdir() + '/pre-trim.json', JSON.stringify(ev));
    // Tramos con el trim quieto más de 1,5 s: qué valores dan pre y post (proporción de tiempo de cada uno)
    const trimEv = ev.filter((e) => e[1] === 'trim');
    console.log(`eventos: ${ev.length}; cambios de trim: ${trimEv.length}; otros mensajes: ${JSON.stringify([...other])}`);
    console.log('valores de trim recibidos:', [...new Set(trimEv.map((e) => e[2].toFixed(4)))].slice(0, 80).join(' '));
    const ends = [...trimEv.map((e) => e[0]), secs * 1000];
    let cur = { t: 0, v: st.trim };
    const firstTrim = trimEv.length ? trimEv[0] : null;
    const segs = [];
    let start = 0, val = firstTrim ? firstTrim[2] : st.trim;
    for (const e of trimEv) { if (e[0] - start > 1500) segs.push([start, e[0], val]); start = e[0]; val = e[2]; }
    if (secs * 1000 - start > 1500) segs.push([start, secs * 1000, val]);
    const at = (w, t) => { let v = null; for (const e of ev) { if (e[0] > t) break; if (e[1] === w) v = e[2]; } return v; };
    for (const [a, b, v] of segs) {
      const dist = { pre: new Map(), post: new Map() };
      for (let t = a + 200; t < b; t += 50) for (const w of ['pre', 'post']) { const x = at(w, t); dist[w].set(x, (dist[w].get(x) || 0) + 1); }
      const fmt = (d) => { const n = [...d.values()].reduce((s, x) => s + x, 0); const mean = [...d].reduce((s, [x, c]) => s + x * c, 0) / n; return [...d].sort((x, y) => x[0] - y[0]).map(([x, c]) => `${x}:${Math.round(100 * c / n)}%`).join(' ') + `  (media ${mean.toFixed(2)})`; };
      console.log(`trim ${v == null ? '?' : v.toFixed(4)}  ${((b - a) / 1000).toFixed(1)} s   pre ${fmt(dist.pre)}   post ${fmt(dist.post)}`);
    }
    process.exit(0);
  }, secs * 1000);
});

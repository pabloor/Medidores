// Se suscribe (como la app) a muchas rutas candidatas de medidor de un canal de entrada y a un grupo de referencia,
// y cuenta para cada una: mensajes, valores distintos de cada mitad y el paso mínimo entre valores.
// Uso: node sondear-entradas.js <canal> <grupo> <segundos>      (canal 0 = buscar entradas con señal)
const dgram = require('dgram');
const osc = require('../../drivers/osc');
const IP = process.env.IP || '192.168.102.121', LOCAL = process.env.LOCAL || undefined; // IP de la mesa; LOCAL = IP del adaptador del Mac (vacío = todos)
const SPORT = Number(process.env.SPORT || 8000), LPORT = Number(process.env.LPORT || 9000); // puertos de la mesa: Receive / Send en External Control
const [ch, grp, secs] = [Number(process.argv[2] || 0), Number(process.argv[3] || 6), Number(process.argv[4] || 20)];
const sock = dgram.createSocket('udp4');
let paths;
if (!ch) paths = Array.from({ length: 48 }, (_, i) => `/Input_Channels/${i + 1}/Channel_Input/post_meter/left`);
else {
  const b = `/Input_Channels/${ch}`;
  paths = [
    `${b}/Channel_Input/post_meter/left`, `${b}/Channel_Input/post_meter/right`, `${b}/Channel_Input/post_meter`,
    `${b}/Channel_Input/pre_meter/left`, `${b}/Channel_Input/pre_meter`, `${b}/Channel_Input/meter/left`,
    `${b}/fader_meter/left`, `${b}/fader_meter/right`, `${b}/fader_meter`,
    `${b}/Output/meter/left`, `${b}/Output/meter/right`, `${b}/meter/left`, `${b}/meter`,
    `${b}/Dynamics/input_meter/left`, `${b}/Dynamics/output_meter/left`, `${b}/Dynamics/gr_meter`,
    `${b}/Dynamics/comp_gr`, `${b}/Dynamics/gate_gr`, `${b}/Dynamics/meter/left`,
    `${b}/Insert/meter/left`, `${b}/Direct_Output/meter/left`, `${b}/Channel_Input/Direct_Output/meter/left`,
    `/Group_Outputs/${grp}/fader_meter/left`, `/Group_Outputs/${grp}/Output/meter/left`,
  ];
}
const st = paths.map(() => ({ n: 0, hi: new Set(), lo: new Set() }));
let other = new Map();
sock.on('message', (b) => {
  let m; try { m = osc.decode(b); } catch { return; }
  if (!m || m.address !== '/Meters/values') { if (m) other.set(m.address, (other.get(m.address) || 0) + 1); return; }
  for (let k = 0; k + 1 < m.args.length; k += 2) {
    const s = st[m.args[k]]; if (!s) continue;
    const v = m.args[k + 1]; s.n++; s.hi.add((v >>> 16) & 0xffff); s.lo.add(v & 0xffff);
  }
});
const step = (set) => { const a = [...set].filter((x) => x < 126).sort((x, y) => x - y); let m = Infinity; for (let i = 1; i < a.length; i++) m = Math.min(m, a[i] - a[i - 1]); return m === Infinity ? '-' : m; };
sock.bind(LPORT, LOCAL, async () => {
  const send = (a, args = []) => sock.send(osc.encode(a, args), SPORT, IP);
  send('/Meters/clear');
  await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < paths.length; i++) { send(`/Meters/request/${i}`, [paths[i]]); await new Promise((r) => setTimeout(r, 10)); }
  setTimeout(() => {
    send('/Meters/clear');
    for (let i = 0; i < paths.length; i++) {
      const s = st[i];
      if (!ch && ![...s.lo].some((x) => x < 126)) continue;
      const lo = [...s.lo].sort((x, y) => x - y), hi = [...s.hi].sort((x, y) => x - y);
      console.log(`${String(i).padStart(2)} ${paths[i].padEnd(52)} msgs ${String(s.n).padStart(4)} (${(s.n / secs).toFixed(1)}/s)  nivel[${lo.length}] paso ${step(s.lo)}: ${lo.join(',')}  pico[${hi.length}] paso ${step(s.hi)}: ${hi.join(',')}`);
    }
    if (other.size) console.log('otros mensajes:', [...other].slice(0, 10));
    setTimeout(() => process.exit(0), 200);
  }, secs * 1000);
});

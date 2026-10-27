// ¿Manda la mesa el valor actual al pedir un medidor? ¿Y si ese valor es 0 (0 dB pico y nivel)?
// Pide post_meter del canal 7 (en 0 dB), post_meter del canal 1 (silencio) y pre_meter del canal 7, tres veces.
const dgram = require('dgram');
const osc = require('../../drivers/osc');
const IP = process.env.IP || '192.168.102.121', LOCAL = process.env.LOCAL || undefined; // IP de la mesa; LOCAL = IP del adaptador del Mac (vacío = todos)
const sock = dgram.createSocket('udp4');
const send = (a, args = []) => sock.send(osc.encode(a, args), 8000, IP);
const t0 = Date.now();
const names = ['post 7', 'post 1', 'pre 7'];
sock.on('message', (b) => {
  let m; try { m = osc.decode(b); } catch { return; }
  if (!m) return;
  const t = Date.now() - t0;
  if (m.address === '/Meters/values') {
    const out = [];
    for (let k = 0; k + 1 < m.args.length; k += 2) out.push(`${names[m.args[k]] || m.args[k]}=${(m.args[k + 1] >>> 16) & 0xffff}/${m.args[k + 1] & 0xffff}`);
    console.log(`${t} ms  /Meters/values  ${out.join('  ')}`);
  } else if (/meter|trim/.test(m.address)) console.log(`${t} ms  ${m.address} ${JSON.stringify(m.args)}`);
});
const req = () => {
  console.log(`${Date.now() - t0} ms  -> peticiones`);
  send('/Meters/request/0', ['/Input_Channels/7/Channel_Input/post_meter/left']);
  send('/Meters/request/1', ['/Input_Channels/1/Channel_Input/post_meter/left']);
  send('/Meters/request/2', ['/Input_Channels/7/Channel_Input/pre_meter/left']);
};
sock.bind(9000, LOCAL, async () => {
  send('/Meters/clear');
  send('/Input_Channels/7/Channel_Input/trim/?');
  await new Promise((r) => setTimeout(r, 150));
  req();                                                    // con borrado previo
  setTimeout(req, 2000);                                    // sin borrar (como la renovación periódica)
  setTimeout(() => { send('/Meters/clear'); setTimeout(req, 100); }, 4000); // borrando otra vez
  setTimeout(() => { console.log(`${Date.now() - t0} ms  -> consulta /?`); send('/Input_Channels/7/Channel_Input/post_meter/left/?'); send('/Input_Channels/7/Channel_Input/post_meter/?'); }, 6000);
  setTimeout(() => { send('/Meters/clear'); process.exit(0); }, 8000);
});

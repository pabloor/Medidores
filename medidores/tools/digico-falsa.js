// Emula una DiGiCo con el protocolo de iPad tal como lo ha descrito la comunidad.
// Uso: node tools/digico-falsa.js   y luego: node server.js --driver digico --ip 127.0.0.1
const dgram = require('dgram');
const osc = require('../drivers/osc');
const sock = dgram.createSocket('udp4');
const subs = new Set();
const ctl = new Map(); // valores de control (fader, mute, ganancia) que ha fijado la app
const HOST = process.env.HOST || '127.0.0.1'; // HOST=192.0.2.2 para probar con una IP de la red
const bundle = (msg) => { const h = Buffer.alloc(16); h.write('#bundle\0', 0, 'ascii'); h.writeUInt32BE(0, 8); h.writeUInt32BE(1, 12); const s = Buffer.alloc(4); s.writeUInt32BE(msg.length); return Buffer.concat([h, s, msg]); };
const reply = (a, args) => { const m = osc.encode(a, args); sock.send(process.env.BUNDLE ? bundle(m) : m, 9000, HOST); }; // BUNDLE=1: como con "Bundles" activado en la mesa
sock.on('message', (b) => {
  const m = osc.decode(b);
  if (m.address === '/Console/Name/?') reply('/Console/Name', ['SD12 12345']);
  else if (m.address === '/Console/Input_Channels/?') reply('/Console/Input_Channels', [24]);
  else if (process.env.METERQ && /meter.*\/\?$/.test(m.address)) {
    // METERQ=1: contesta a la consulta de medidor con un OSC "sin etiquetas" (dirección + float), como DiGiCo
    const addr = Buffer.from(m.address.slice(0, -2) + '\0'); const pad = (x) => Buffer.concat([x, Buffer.alloc((4 - (x.length % 4)) % 4)]);
    const f = Buffer.alloc(4); f.writeFloatBE(Math.round((0.5 + 0.5 * Math.sin(Date.now() / 700)) * 100) / 100); // valor que cambia con el tiempo
    sock.send(Buffer.concat([pad(addr), f]), 9000, HOST);
  }
  else if (/^\/Input_Channels\/\d+\/(fader|mute|Channel_Input\/analog_gain)\/\?$/.test(m.address)) {
    // consulta de un parámetro de control: responde con el valor guardado (o uno por defecto)
    const a = m.address.slice(0, -2);
    const v = ctl.has(a) ? ctl.get(a) : /fader$/.test(a) ? 0 : /mute$/.test(a) ? 0 : 20;
    reply(a, [osc.float(v)]);
  }
  else if (/^\/Input_Channels\/\d+\/(fader|mute|Channel_Input\/analog_gain)$/.test(m.address) && m.args.length) {
    ctl.set(m.address, m.args[0]); console.log(`[set] ${m.address} = ${m.args[0]}`);
  }
  else if (m.address === '/Meters/clear') subs.clear();
  else if (m.address.endsWith('/post_meter')) { if (!process.env.NOMETERS) subs.add(m.args[0]); } // NOMETERS=1: no manda medidores, como la mesa de un usuario
  else if (m.address.endsWith('/name/?')) reply(m.address.slice(0, -2), [`Canal ${m.address.split('/')[2]}`]);
});
setInterval(() => {
  if (!subs.size) return;
  const t = Date.now() / 1000, args = [];
  for (const id of subs) { args.push(id, Math.pow(10, (-30 + 20 * Math.sin(t * 2 + id * 0.4)) / 20)); }
  sock.send(osc.encode('/Meters/values', args), 9000, HOST);
}, 50);
// Cada 2 s "alguien" toca la mesa: fader, mute y ganancia (trim) de algunos canales, como llegan de una mesa real.
let k = 0;
setInterval(() => {
  k++;
  sock.send(osc.encode('/Input_Channels/3/fader', [osc.float(k % 2 ? -10 : 0)]), 9000, HOST);
  sock.send(osc.encode('/Input_Channels/5/mute', [k % 2]), 9000, HOST);
  sock.send(osc.encode('/Input_Channels/2/Channel_Input/trim', [osc.float(0.6315789222717285)]), 9000, HOST);
}, 2000);

sock.bind(8000, () => console.log('DiGiCo falsa escuchando en UDP 8000 (responde a 9000)'));

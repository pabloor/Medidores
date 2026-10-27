// Emula una DiGiCo con el protocolo de iPad tal como lo ha descrito la comunidad.
// Uso: node tools/digico-falsa.js   y luego: node server.js --driver digico --ip 127.0.0.1
const dgram = require('dgram');
const osc = require('../drivers/osc');
const sock = dgram.createSocket('udp4');
const subs = new Set();
const HOST = process.env.HOST || '127.0.0.1'; // HOST=192.0.2.2 para probar con una IP de la red
const reply = (a, args) => sock.send(osc.encode(a, args), 9000, HOST);
sock.on('message', (b) => {
  const m = osc.decode(b);
  if (m.address === '/Console/Name/?') reply('/Console/Name', ['SD12 12345']);
  else if (m.address === '/Console/Input_Channels/?') reply('/Console/Input_Channels', [24]);
  else if (process.env.METERQ && /\/post_meter\/\?$/.test(m.address)) {
    // METERQ=1: contesta a la consulta de medidor con un OSC "sin etiquetas" (dirección + float), como DiGiCo
    const addr = Buffer.from(m.address.slice(0, -2) + '\0'); const pad = (x) => Buffer.concat([x, Buffer.alloc((4 - (x.length % 4)) % 4)]);
    const f = Buffer.alloc(4); f.writeFloatBE(0.2);
    sock.send(Buffer.concat([pad(addr), f]), 9000, HOST);
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

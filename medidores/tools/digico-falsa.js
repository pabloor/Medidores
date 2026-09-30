// Emula una DiGiCo con el protocolo de iPad tal como lo ha descrito la comunidad.
// Uso: node tools/digico-falsa.js   y luego: node server.js --driver digico --ip 127.0.0.1
const dgram = require('dgram');
const osc = require('../drivers/osc');
const sock = dgram.createSocket('udp4');
const subs = new Set();
const reply = (a, args) => sock.send(osc.encode(a, args), 9000, '127.0.0.1');
sock.on('message', (b) => {
  const m = osc.decode(b);
  if (m.address === '/Console/Name/?') reply('/Console/Name', ['SD12 12345']);
  else if (m.address === '/Console/Input_Channels/?') reply('/Console/Input_Channels', [24]);
  else if (m.address === '/Meters/clear') subs.clear();
  else if (m.address.endsWith('/post_meter')) subs.add(m.args[0]);
  else if (m.address.endsWith('/name/?')) reply(m.address.slice(0, -2), [`Canal ${m.address.split('/')[2]}`]);
});
setInterval(() => {
  if (!subs.size) return;
  const t = Date.now() / 1000, args = [];
  for (const id of subs) { args.push(id, Math.pow(10, (-30 + 20 * Math.sin(t * 2 + id * 0.4)) / 20)); }
  sock.send(osc.encode('/Meters/values', args), 9000, '127.0.0.1');
}, 50);
sock.bind(8000, () => console.log('DiGiCo falsa escuchando en UDP 8000 (responde a 9000)'));

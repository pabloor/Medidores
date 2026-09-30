// Emula una X32 (o una XR18 con --xair) en la red para probar el driver real sin hardware.
// Uso: node tools/mesa-falsa.js [--xair]   y en otra terminal: node server.js --ip 127.0.0.1 --driver x32
const dgram = require('dgram');
const osc = require('../drivers/osc');

const xair = process.argv.includes('--xair');
const PORT = xair ? 10024 : 10023;
const sock = dgram.createSocket('udp4');
const subs = new Map(); // "ip:port|path" -> caduca

function blob(path, t) {
  const n = xair ? 40 : path === '/meters/1' ? 96 : 49;
  const b = Buffer.alloc(4 + n * (xair ? 2 : 4));
  b.writeInt32LE(n, 0);
  for (let i = 0; i < n; i++) {
    const db = -30 + 20 * Math.sin(t * 2 + i * 0.4); // onda distinta por índice
    if (xair) b.writeInt16LE(Math.round(Math.min(0, db) * 256), 4 + i * 2);
    else b.writeFloatLE(Math.min(1, 10 ** (db / 20)), 4 + i * 4);
  }
  return b;
}

sock.on('message', (buf, r) => {
  const m = osc.decode(buf);
  const reply = (addr, args) => sock.send(osc.encode(addr, args), r.port, r.address);
  if (m.address === '/xinfo') reply('/xinfo', ['127.0.0.1', xair ? 'XR18-Prueba' : 'X32-Prueba', xair ? 'XR18' : 'X32', '4.06']);
  else if (m.address === '/meters') subs.set(`${r.address}:${r.port}|${m.args[0]}`, Date.now() + 10000);
  else if (m.address.endsWith('/config/name')) reply(m.address, [m.address.includes('/ch/') ? `Fuente ${m.address.match(/\d+/)[0]}` : '']);
});

setInterval(() => {
  const t = Date.now() / 1000;
  for (const [key, until] of subs) {
    if (Date.now() > until) { subs.delete(key); continue; }
    const [dest, path] = key.split('|');
    const [ip, port] = dest.split(':');
    sock.send(buildBlobMsg(path, blob(path, t)), Number(port), ip);
  }
}, 50);

function buildBlobMsg(path, data) {
  const head = Buffer.concat([pad(Buffer.from(path + '\0')), pad(Buffer.from(',b\0'))]);
  const len = Buffer.alloc(4); len.writeInt32BE(data.length);
  return Buffer.concat([head, len, pad(data)]);
}
function pad(b) { return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]); }

sock.bind(PORT, () => console.log(`Mesa falsa ${xair ? 'XR18' : 'X32'} escuchando en UDP ${PORT}`));

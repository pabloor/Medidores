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

// Control (solo X32): estado de fader, ON, previos y links, como una X32 real.
// Los cambios se envían a quien haya mandado /xremote en los últimos 10 s (menos a quien los hizo).
const state = new Map();                 // dirección -> valor ({ f: número } si va como float)
const remotes = new Map();               // "ip:puerto" -> caduca
const fl = (v) => ({ f: v });
function defaultValue(addr) {
  let m;
  if (/\/mix\/fader$/.test(addr) || /^\/dca\/\d\/fader$/.test(addr)) return fl(0.75);
  if (/\/mix\/on$/.test(addr) || /^\/dca\/\d\/on$/.test(addr)) return 1;
  if ((m = /^\/ch\/(\d\d)\/config\/source$/.exec(addr))) return Number(m[1]);
  // ROUTE0=4: el bloque de entradas 1-8 llega por AES50-A (A1-8), como con una caja de escenario
  if ((m = /^\/config\/routing\/IN\/(\d+)-/.exec(addr))) return m[1] === '1' && process.env.ROUTE0 ? Number(process.env.ROUTE0) : (Number(m[1]) - 1) / 8;
  if ((m = /^\/headamp\/(\d{3})\/gain$/.exec(addr))) return fl((20 + (Number(m[1]) % 10) + 12) / 72);
  if ((m = /^\/config\/(ch|bus|mtx)link\/(\d+)-/.exec(addr))) return m[1] === 'ch' && m[2] === '1' ? 1 : 0; // canales 1-2 enlazados
}
const argOf = (v) => (v && typeof v === 'object' ? osc.float(v.f) : v);
const notify = (addr, v, exceptKey) => {
  for (const [key, until] of remotes) {
    if (Date.now() > until) { remotes.delete(key); continue; }
    if (key === exceptKey) continue;
    const [ip, port] = key.split(':');
    sock.send(osc.encode(addr, [argOf(v)]), Number(port), ip);
  }
};

sock.on('message', (buf, r) => {
  const m = osc.decode(buf);
  // DROP=0.5 node tools/mesa-falsa.js : pierde esa fracción de las respuestas, como una red wifi saturada (para probar los reintentos)
  const drop = Number(process.env.DROP || 0);
  const reply = (addr, args) => { if (drop && Math.random() < drop) return; sock.send(osc.encode(addr, args), r.port, r.address); };
  if (!xair && m.address === '/xremote') { remotes.set(`${r.address}:${r.port}`, Date.now() + 10000); return; }
  if (!xair && /^\/(ch|bus|mtx|main|headamp|config|dca)\//.test(m.address) && !m.address.endsWith('/config/name')) {
    if (m.args.length === 0) {
      const v = state.has(m.address) ? state.get(m.address) : defaultValue(m.address);
      if (v !== undefined) reply(m.address, [argOf(v)]);
    } else {
      const v = typeof m.args[0] === 'number' && m.address.match(/(fader|gain)$/) ? fl(m.args[0]) : m.args[0];
      state.set(m.address, v);
      console.log(`[set] ${m.address} = ${typeof v === 'object' ? v.f.toFixed(4) : v}`);
      notify(m.address, v, `${r.address}:${r.port}`);
    }
    return;
  }
  if (m.address === '/xinfo') reply('/xinfo', ['127.0.0.1', xair ? 'XR18-Prueba' : 'X32-Prueba', xair ? 'XR18' : 'X32', '4.06']);
  else if (m.address === '/meters') subs.set(`${r.address}:${r.port}|${m.args[0]}`, Date.now() + 10000);
  else if (m.address.endsWith('/config/name')) reply(m.address, [m.address.includes('/ch/') ? `Fuente ${m.address.match(/\d+/)[0]}` : m.address.includes('/dca/') ? `DCA ${m.address.match(/\d+/)[0]}` : '']);
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

// Cada 7 s "alguien" mueve en la mesa el fader del canal 1, para probar que la app se entera.
if (!xair) setInterval(() => {
  const cur = state.get('/ch/01/mix/fader');
  const v = fl(cur && cur.f === 0.5 ? 0.75 : 0.5);
  state.set('/ch/01/mix/fader', v);
  notify('/ch/01/mix/fader', v, null);
}, 7000);

sock.bind(PORT, () => console.log(`Mesa falsa ${xair ? 'XR18' : 'X32'} escuchando en UDP ${PORT}`));

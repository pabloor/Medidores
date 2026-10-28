// Recorre el árbol de rutas OSC de una DiGiCo con consultas "/?" y guarda lo que contesta. Solo LEE: no cambia nada.
// La mesa contesta a "<ruta>/?" con sus rutas hijas (sin argumentos) o con el valor del parámetro (con argumentos);
// así se vio, por ejemplo, la lista de medidores de un canal. Sirve para buscar dónde están los gangs y los canales estéreo.
// Uso: node listar-rutas.js [ruta inicial…]      (por defecto /Console, /Input_Channels/1 y algunas posibles de gangs)
//      IP=… LOCAL=… como en los demás scripts. PROF=4 (profundidad) y MAX=600 (consultas como mucho).
// Guarda la lista completa en la carpeta temporal del sistema (rutas-digico.txt) e imprime las que tienen que ver
// con gang, link, stereo, mode o pair.
const dgram = require('dgram');
const fs = require('fs');
const osc = require('../../drivers/osc');
const IP = process.env.IP || '192.168.102.121', LOCAL = process.env.LOCAL || undefined; // IP de la mesa; LOCAL = IP del adaptador del Mac (vacío = todos)
const PROF = Number(process.env.PROF || 4), MAX = Number(process.env.MAX || 600);
const roots = process.argv.slice(2).length ? process.argv.slice(2)
  : ['/Console', '/Input_Channels/1', '/Input_Channels/1/Channel_Input', '/Gangs', '/Console/Gangs', '/Control_Groups/1'];
const sock = dgram.createSocket('udp4');
const send = (a) => sock.send(osc.encode(a, []), 8000, IP);
const seen = new Map();     // ruta -> argumentos (null = sin argumentos: es una rama)
const asked = new Set(), queue = [...roots];
const depthOf = new Map(roots.map((r) => [r, 0])); // profundidad de cada rama desde su ruta inicial
sock.on('message', (b) => {
  let m; try { m = osc.decode(b); } catch { return; }
  if (!m || m.address === '/Meters/values') return;
  const args = m.args.map((a) => (Buffer.isBuffer(a) ? `<${a.length} bytes>` : a));
  if (!seen.has(m.address)) seen.set(m.address, args.length ? args : null);
  if (!args.length && !depthOf.has(m.address)) {
    // rama: se consulta también, un nivel más abajo que la ruta consultada que la contiene
    const parent = [...depthOf.keys()].filter((a) => m.address.startsWith(a + '/')).sort((x, y) => y.length - x.length)[0];
    const depth = parent ? depthOf.get(parent) + 1 : 0;
    depthOf.set(m.address, depth);
    if (depth < PROF) queue.push(m.address);
  }
});
sock.bind(9000, LOCAL, async () => {
  let n = 0;
  while (n < MAX) {
    const next = queue.shift();
    if (!next) { await new Promise((r) => setTimeout(r, 600)); if (!queue.length) break; continue; }
    const p = next;
    if (asked.has(p)) continue;
    asked.add(p); n++;
    send(`${p}/?`);
    await new Promise((r) => setTimeout(r, 25)); // espaciado: las SD pierden ráfagas
  }
  await new Promise((r) => setTimeout(r, 800));
  const lines = [...seen].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))
    .map(([a, v]) => `${a}${v ? '  ' + JSON.stringify(v).slice(0, 160) : '  (rama)'}`);
  const file = require('os').tmpdir() + '/rutas-digico.txt';
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log(`${n} consultas, ${seen.size} rutas. Lista completa: ${file}`);
  console.log('Rutas que parecen de gangs, enlaces o estéreo:');
  const hits = lines.filter((l) => /gang|link|stereo|mode|pair|width/i.test(l));
  console.log(hits.length ? hits.join('\n') : '  (ninguna)');
  process.exit(0);
});

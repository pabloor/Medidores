// Escucha cómo se anuncian en la red los equipos Shure (para escribir shureDiscover() en server.js). Solo ESCUCHA: no manda nada.
// Wireless Workbench encuentra los equipos sin que se escriba su IP, así que se anuncian de alguna forma. Candidatos:
//   SLP (Service Location Protocol)  multicast 239.255.255.253, UDP 427
//   mDNS / Bonjour                    multicast 224.0.0.251, UDP 5353
//   Multicast propio de Shure         239.255.254.253, UDP 8427 (sin confirmar)
//   Difusión (broadcast) a la red     UDP 427, 8427
// Uso: node tools/shure-pruebas/escuchar-descubrimiento.js <adaptador> [segundos]     p. ej.: node … en9 60
//      Con los equipos encendidos en esa red. Si puedes, abre Wireless Workbench mientras escucha (sus búsquedas y las
//      respuestas de los equipos también se ven) y enciende o reinicia algún emisor (se anuncian al arrancar).
// Muestra, por cada origen y puerto, cuántos paquetes, su tamaño y el principio en texto. Guarda todo en la carpeta temporal
// (descubrimiento-shure.txt). Para ver también el tráfico de unidifusión: sudo tcpdump -n -i <adaptador> udp port 427 or udp port 8427 or udp port 5353
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');

const nic = process.argv[2], secs = Number(process.argv[3] || 60);
const a = nic && (os.networkInterfaces()[nic] || []).find((x) => (x.family === 'IPv4' || x.family === 4) && !x.internal);
if (!a) { console.log(`Uso: node escuchar-descubrimiento.js <adaptador> [segundos]\nAdaptadores: ${Object.keys(os.networkInterfaces()).join(', ')}`); process.exit(1); }
const GROUPS = [['239.255.255.253', 427, 'SLP'], ['224.0.0.251', 5353, 'mDNS'], ['239.255.254.253', 8427, 'Shure?']];
const file = os.tmpdir() + '/descubrimiento-shure.txt';
const log = fs.createWriteStream(file);
const stats = new Map(); // "origen → puerto (protocolo)" -> { n, sizes:Set, sample }
const t0 = Date.now();
const printable = (b) => b.toString('latin1').replace(/[^\x20-\x7e]+/g, '·').slice(0, 120);

for (const [group, port, name] of GROUPS) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => console.log(`[${name}] no se puede escuchar en ${port}: ${e.message}`));
  sock.on('message', (msg, r) => {
    if (r.address === a.address) return; // lo que manda este Mac
    const k = `${r.address} → ${port} (${name})`;
    const st = stats.get(k) || { n: 0, sizes: new Set(), sample: '' };
    st.n++; st.sizes.add(msg.length);
    if (!st.sample) st.sample = printable(msg);
    stats.set(k, st);
    log.write(`${((Date.now() - t0) / 1000).toFixed(2)}  ${k}  ${msg.length} bytes\n  ${msg.toString('hex')}\n  ${printable(msg)}\n`);
  });
  sock.bind(port, () => {
    try { sock.addMembership(group, a.address); console.log(`Escuchando ${name} en ${group}:${port} por ${nic} (${a.address})`); }
    catch (e) { console.log(`[${name}] no se pudo unir a ${group}: ${e.message}`); }
  });
}
function report() {
  console.log(`\n================ RESUMEN (${Math.round((Date.now() - t0) / 1000)} s) ================`);
  if (!stats.size) console.log('  No ha llegado ningún anuncio. Prueba con Wireless Workbench abierto o reiniciando un emisor, y mira también con tcpdump.');
  for (const [k, st] of [...stats].sort((x, y) => y[1].n - x[1].n)) console.log(`  ${String(st.n).padStart(4)} x ${k}  tamaños ${[...st.sizes].slice(0, 6).join('/')}  ${st.sample}`);
  console.log(`Todos los paquetes, en hexadecimal y texto: ${file}`);
  log.end(() => process.exit(0));
}
process.on('SIGINT', report);
setTimeout(report, secs * 1000);

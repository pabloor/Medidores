// Conecta el driver DiGiCo a una mesa (falsa o real) y muestra niveles de buses y lo que se ha pedido.
// Uso: node probar-digico.js <ip> [nic] [segundos]
const DiGiCo = require('../../drivers/digico');
const [ip, nic, secs] = [process.argv[2], process.argv[3] || '', Number(process.argv[4] || 6)];
const d = new DiGiCo({ ip, nic, 'listen-port': process.env.LPORT || 9000, 'send-port': process.env.SPORT || 8000 }); // LPORT=9100 con la mesa falsa en PORT=9100
let layout = null, last = null;
d.on('layout', (l) => { layout = l; });
d.on('levels', (lv) => { last = lv; });
d.on('status', (s) => console.log('estado:', s.detail));
d.start();
setTimeout(() => {
  const reqs = [...d.tx.byAddress.keys()].filter((k) => /Meters\/request/.test(k));
  console.log('salidas:', d.out, 'entradas:', d.count, 'ids derechos desde', d.rightBase());
  console.log('peticiones de medidor enviadas:', reqs, [...d.tx.byAddress.entries()].filter(([k]) => /Meters\/request/.test(k)).map(([, v]) => v));
  if (last) {
    console.log('buses (aux + grupos):', (last[1] || []).map((v) => Math.round(v)).join(' '));
    console.log('matrices:', (last[2] || []).map((v) => Math.round(v)).join(' '));
    console.log('busL:', d.busL.map((v) => v == null ? '-' : Math.round(v)).join(' '));
    console.log('busR:', d.busR.map((v) => v == null ? '-' : Math.round(v)).join(' '));
  } else console.log('no han llegado niveles');
  d.send('/Meters/clear'); setTimeout(() => process.exit(0), 100); // que la mesa deje de mandar medidores al terminar
}, secs * 1000);

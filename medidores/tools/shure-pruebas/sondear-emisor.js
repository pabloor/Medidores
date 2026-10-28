// Sondea emisores de IEM Shure en red (PSM 1000 P10T, Axient Digital PSM ADTD/ADTQ) para saber qué mandan de nivel de audio.
// Protocolo de control de Shure: TCP 2202, mensajes de texto "< GET 1 CLAVE >", "< SET 1 CLAVE valor >"; el equipo
// contesta "< REP … >" (o "< REPORT … >" en equipos antiguos) y, con la medición activada, "< SAMPLE … >".
//
// Qué hace:
//   1. Pide datos del equipo y de cada canal (modelo, nombre, nivel de entrada configurado…).
//   2. Activa la medición en cada canal (SET x METER_RATE <ms>) y registra todo lo que llega mientras mandas tono a cada bus.
//   3. Al terminar deja METER_RATE en 0 (medición apagada, el valor de fábrica) y resume: mensajes, ritmo y valores de cada campo.
// Lo único que cambia en el emisor es METER_RATE, y lo deja como estaba de fábrica. No toca frecuencias, niveles ni RF.
// Cierra Wireless Workbench durante la prueba para que no se mezclen sus consultas.
//
// Uso: node tools/shure-pruebas/sondear-emisor.js <ip[:puerto]> [<ip[:puerto]> …]
//      SEG=60 (duración, por defecto 60 s), RATE=200 (ms entre muestras), CANALES=4, LOCAL=<IP del adaptador del Mac>
//      Ctrl+C termina antes y también imprime el resumen.
// Guarda todos los mensajes, con su hora, en la carpeta temporal del sistema (emisores-shure.txt).
const net = require('net');
const fs = require('fs');
const os = require('os');

const targets = process.argv.slice(2);
if (!targets.length) { console.log('Uso: node sondear-emisor.js <ip[:puerto]> [más IP…]'); process.exit(1); }
const SEG = Number(process.env.SEG || 60), RATE = Number(process.env.RATE || 200), CANALES = Number(process.env.CANALES || 4);
const LOCAL = process.env.LOCAL || undefined;
const t0 = Date.now();
const logFile = os.tmpdir() + '/emisores-shure.txt';
const log = fs.createWriteStream(logFile);
const stats = new Map(); // "ip  TIPO canal CLAVE" -> { n, first, last, fields: [{ min, max, vals:Set, sample }] }
const socks = [];

// Consultas de información (las que el equipo no entienda contestarán con un error o nada: también es información)
const INFO = ['DEVICE_ID', 'MODEL', 'FW_VER', 'RF_BAND'];
const PER_CH = ['CHAN_NAME', 'AUDIO_IN_LVL', 'AUDIO_IN_LINE_LVL', 'AUDIO_INPUT_GAIN', 'AUDIO_GAIN', 'INPUT_MODE', 'AUDIO_MODE', 'METER_RATE', 'RF_TX_LVL', 'RF_MUTE', 'FREQUENCY'];

function note(ip, msg) {
  const tok = msg.trim().split(/\s+/);
  const [kind, ch, key, ...vals] = tok;
  const k = `${ip}  ${kind} ${ch ?? ''} ${key ?? ''}`;
  const s = stats.get(k) || { n: 0, first: Date.now(), last: 0, fields: [] };
  s.n++; s.last = Date.now();
  vals.forEach((v, i) => {
    const f = s.fields[i] || (s.fields[i] = { min: Infinity, max: -Infinity, vals: new Set(), sample: v });
    const x = Number(v);
    if (Number.isFinite(x)) { f.min = Math.min(f.min, x); f.max = Math.max(f.max, x); }
    if (f.vals.size < 200) f.vals.add(v);
  });
  stats.set(k, s);
}

function connect(target) {
  const [host, port] = target.includes(':') ? target.split(':') : [target, '2202'];
  const sock = net.connect({ host, port: Number(port), ...(LOCAL ? { localAddress: LOCAL } : {}) });
  sock.setEncoding('ascii');
  const send = (cmd) => { if (!sock.destroyed) sock.write(`< ${cmd} >\r\n`); log.write(`${((Date.now() - t0) / 1000).toFixed(2)}  ${host} -> ${cmd}\n`); };
  let buf = '';
  sock.on('connect', async () => {
    console.log(`[${host}] conectado`);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const k of INFO) { send(`GET ${k}`); await wait(40); }
    send('GET 0 ALL'); await wait(400); // en Axient Digital devuelve todos los parámetros de todos los canales
    for (let c = 1; c <= CANALES; c++) for (const k of PER_CH) { send(`GET ${c} ${k}`); await wait(40); }
    for (let c = 1; c <= CANALES; c++) { send(`SET ${c} METER_RATE ${String(RATE).padStart(5, '0')}`); await wait(40); }
    console.log(`[${host}] medición activada cada ${RATE} ms. Manda tono a cada bus, uno detrás de otro, unos segundos cada uno.`);
  });
  sock.on('data', (d) => {
    buf += d;
    let a, b;
    while ((a = buf.indexOf('<')) >= 0 && (b = buf.indexOf('>', a)) >= 0) {
      const msg = buf.slice(a + 1, b).trim();
      buf = buf.slice(b + 1);
      log.write(`${((Date.now() - t0) / 1000).toFixed(2)}  ${host} <- ${msg}\n`);
      note(host, msg);
    }
  });
  sock.on('error', (e) => console.log(`[${host}] error: ${e.message}`));
  sock.on('close', () => console.log(`[${host}] conexión cerrada`));
  socks.push({ host, sock, send });
}

let done = false;
async function finish() {
  if (done) return; done = true;
  for (const { sock, send } of socks) if (!sock.destroyed) for (let c = 1; c <= CANALES; c++) send(`SET ${c} METER_RATE 00000`); // medición apagada, como de fábrica
  await new Promise((r) => setTimeout(r, 500));
  const secs = (Date.now() - t0) / 1000;
  console.log(`\n================ RESUMEN (${secs.toFixed(0)} s) ================`);
  const keys = [...stats.keys()].sort();
  if (!keys.length) console.log('  No ha llegado ningún mensaje. ¿IP correcta? ¿El emisor tiene el control por red activado?');
  for (const k of keys) {
    const s = stats.get(k);
    const rate = s.n > 1 ? `${(s.n / Math.max(0.001, (s.last - s.first) / 1000)).toFixed(1)}/s` : '';
    const fields = s.fields.map((f, i) => {
      const num = Number.isFinite(f.min) ? ` ${f.min}…${f.max}` : '';
      const few = f.vals.size <= 6 ? ` {${[...f.vals].join(', ')}}` : ` (${f.vals.size} valores distintos)`;
      return `[${i + 1}]${num}${few}`;
    }).join('  ');
    console.log(`  ${String(s.n).padStart(5)} x ${k.padEnd(42)} ${rate.padEnd(8)} ${fields}`);
  }
  console.log(`Mensajes completos con su hora: ${logFile}`);
  console.log('=====================================================');
  for (const { sock } of socks) sock.end();
  log.end(() => process.exit(0));
}
process.on('SIGINT', finish);
targets.forEach(connect);
setTimeout(finish, SEG * 1000);

// Emula una Yamaha por RCP (TCP 49280) para probar el driver sin mesa.
// Uso: node tools/yamaha-falsa.js [--modelo DM7|TF5|CL5]   y luego conecta a 127.0.0.1 desde la app.
// Imita: caducidad de los medidores a los 10 s, get/set de faders, ON y ganancia,
// y cada 6 s "alguien" mueve el fader del canal 1 en la mesa (para probar la sincronización).
const net = require('net');
const i = process.argv.indexOf('--modelo');
const MODEL = i > 0 ? process.argv[i + 1] : 'DM7';
const METERS = {
  TF5: { InCh: 40, StInCh: 4, FxRtnCh: 4, Mix: 20, Mtrx: 4, St: 2, Mono: 1 },
  DM7: { InCh: 72, Mix: 48, Mtrx: 12, St: 4 },
  CL5: { Mix: 24, Mtrx: 8 },
}[MODEL] || {};
const CH = METERS.InCh || 72;
const ST = MODEL === 'DM7' ? 2 : 1;

// Parámetros: dirección -> array de valores por canal
const params = {
  'MIXER:Current/InCh/Fader/Level': Array.from({ length: CH }, (_, k) => (k % 3 === 0 ? -32768 : -1000 + k * 10)),
  'MIXER:Current/InCh/Fader/On': Array.from({ length: CH }, (_, k) => (k % 5 === 4 ? 0 : 1)),
  'MIXER:Current/St/Fader/Level': Array.from({ length: ST }, () => 0),
  'MIXER:Current/Mix/Fader/Level': Array.from({ length: METERS.Mix || 0 }, (_, k) => -500 - k * 100),
  'MIXER:Current/Mix/Fader/On': Array.from({ length: METERS.Mix || 0 }, () => 1),
  'MIXER:Current/Mtrx/Fader/Level': Array.from({ length: METERS.Mtrx || 0 }, () => 0),
  'MIXER:Current/Mtrx/Fader/On': Array.from({ length: METERS.Mtrx || 0 }, (_, k) => (k < 2 ? 1 : 0)),
  'MIXER:Current/St/Fader/On': Array.from({ length: ST }, () => 1),
};
// Como la DM7C real: unos canales responden en dB enteros y otros (45-48) en centésimas (2000 = 20,00 dB).
if (MODEL === 'DM7') params['MIXER:Current/InCh/Port/HA/Gain'] = Array.from({ length: CH }, (_, k) => (k === 10 || k === 24 || k === 25 ? null : k >= 44 && k <= 47 ? (18 + (k % 3)) * 100 : 20 + (k % 30)));
// Grupos de link como en la DM7C real: 1-2, 3-4, 41-42 (grupo 12), 47-48 (grupo 14)… La ganancia no se propaga.
const LINKS = { 0: 1, 1: 1, 2: 2, 3: 2, 20: 5, 21: 5, 22: 5, 23: 5, 40: 12, 41: 12, 46: 14, 47: 14 };
// Canales estéreo como en la DM7C real: 1-2 (también en link), 67-68, 69-70, 71-72 (sin link).
const ROLES = { 0: 'StereoL', 1: 'StereoR', 66: 'StereoL', 67: 'StereoR', 68: 'StereoL', 69: 'StereoR', 70: 'StereoL', 71: 'StereoR' };
const names = Array.from({ length: CH }, (_, k) => ['Bombo', 'Caja', 'Voz', 'Bajo'][k] || `InCh ${k + 1}`);

const clients = new Set();
function notifyAll(addr, x, v, except) {
  for (const c of clients) if (c !== except) c.write(`NOTIFY set ${addr} ${x} 0 ${v} "${v}"\n`);
}

net.createServer((c) => {
  clients.add(c);
  const subs = {};
  let buf = '';
  c.on('data', (d) => {
    buf += d; const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
      const [cmd, addr, x, , val] = line.split(' ');
      if (cmd === 'devinfo') c.write(`OK devinfo productname "${MODEL}"\n`);
      else if (cmd === 'mtrstart') {
        const grp = addr.split('/')[1];
        if (METERS[grp] && !(MODEL === 'CL5' && !addr.endsWith('PostOn'))) { subs[addr] = [METERS[grp], Date.now() + 10000]; c.write(`OK mtrstart ${addr}\n`); }
        else c.write('ERROR mtrstart UnknownAddress\n');
      } else if (cmd === 'prminfo') {
        const list = ['"MIXER:Current/InCh/Fader/Level" 72 1 -32768 1000 -32768 "dB" integer any rw 100',
          '"MIXER:Current/InputChLink/InCh/Assign" 72 1 0 52 0 "" integer any rw 1'];
        const n = Number(addr);
        c.write(list[n] ? `OK prminfo ${n} ${list[n]}\n` : 'ERROR prminfo InvalidArgument\n');
      } else if (cmd === 'get' && addr === 'MIXER:Current/InputChLink/InCh/Assign') c.write(`OK get ${addr} ${x} 0 ${LINKS[x] || 0}\n`);
      else if (cmd === 'get' && addr === 'MIXER:Current/InCh/Role') c.write(`OK get ${addr} ${x} 0 "${ROLES[x] || 'Mono'}"\n`);
      else if (cmd === 'link') { LINKS[Number(addr)] = Number(x); c.write('OK link\n'); } // solo para pruebas: vincula sin avisar
      else if (cmd === 'get' && addr === 'MIXER:Current/InputChLink/LinkParams/HA') c.write(`OK get ${addr} ${x} 0 1\n`);
      else if (cmd === 'get' && addr.endsWith('/Label/Name')) c.write(`OK get ${addr} ${x} 0 "${addr.includes('/Mix/') ? ['Mon Voz', 'Mon Guit', 'Mon Bajo', 'Mon Bat'][x] || `Mix ${Number(x) + 1}` : addr.includes('/Mtrx/') ? ['PA L', 'PA R', 'Front'][x] || `Mtx ${Number(x) + 1}` : names[x] || ''}"\n`);
      else if (cmd === 'get' || cmd === 'set') {
        const arr = params[addr];
        if (!arr || arr[x] === undefined || arr[x] === null) { c.write(`ERROR ${cmd} InvalidArgument\n`); continue; }
        if (cmd === 'set') { arr[x] = Number(val); notifyAll(addr, x, arr[x], c); }
        c.write(`OK ${cmd} ${addr} ${x} 0 ${arr[x]}\n`);
      }
    }
  });
  const t = setInterval(() => {
    const now = Date.now() / 1000;
    for (const [addr, [n, until]] of Object.entries(subs)) {
      if (Date.now() > until) continue;
      const vals = Array.from({ length: n }, (_, k) => {
        if (MODEL === 'DM7' && addr.includes('InCh') && (k === 4 || k === 5)) return (k === 4 ? 215 : 216).toString(16); // −0,2 dB y 0 dB exactos
        if (MODEL === 'DM7' && addr.includes('InCh') && k === 29) return (Math.random() < 0.5 ? 24 : 25).toString(16); // canal 30: zumbido constante (~−57 dB)
        if (MODEL === 'DM7' && addr.includes('InCh') && k === 30) return '00'; // canal 31: sin señal
        const v = MODEL === 'DM7' ? 150 + 50 * Math.sin(now * 2 + k) : 96 + 25 * Math.sin(now * 2 + k * 0.5);
        return Math.max(0, Math.round(v)).toString(16).padStart(2, '0');
      });
      c.write(`NOTIFY mtr ${addr} level ${vals.join(' ')}\n`);
    }
  }, 50);
  c.on('close', () => { clearInterval(t); clients.delete(c); });
  c.on('error', () => {});
}).listen(49280, () => console.log(`Yamaha falsa (${MODEL}) escuchando en TCP 49280`));

// Movimiento "en la mesa" del fader del canal 1
setInterval(() => {
  const arr = params['MIXER:Current/InCh/Fader/Level'];
  arr[0] = arr[0] === -500 ? 0 : -500;
  notifyAll('MIXER:Current/InCh/Fader/Level', 0, arr[0]);
}, 6000);

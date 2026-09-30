// Diagnóstico de solo lectura para mesas Yamaha: pide a la mesa la lista de todos sus parámetros
// (prminfo) y el valor actual de los relacionados con link/pareja. No cambia nada en la mesa.
// Uso: node tools/volcar-parametros.js 192.168.0.2
const net = require('net');
const fs = require('fs');
const path = require('path');

const ip = process.argv[2];
if (!ip) { console.log('Uso: node tools/volcar-parametros.js IP-DE-LA-MESA'); process.exit(1); }

const tokens = (line) => (line.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));
const sock = net.connect(49280, ip);
sock.setEncoding('utf8');
let buf = '', waiting = null;
sock.on('data', (d) => {
  buf += d;
  const lines = buf.split('\n'); buf = lines.pop();
  for (const l of lines.map((x) => x.trim())) {
    if (!l || l.startsWith('NOTIFY')) continue;
    if (waiting) { const w = waiting; waiting = null; w(l); }
  }
});
sock.on('error', (e) => { console.error(`No se puede conectar con ${ip}: ${e.message}`); process.exit(1); });
const ask = (cmd) => new Promise((resolve) => {
  waiting = resolve;
  sock.write(cmd + '\n');
  setTimeout(() => { if (waiting === resolve) { waiting = null; resolve('TIMEOUT'); } }, 1500);
});

sock.on('connect', async () => {
  const out = [];
  const model = tokens(await ask('devinfo productname'))[3] || 'desconocido';
  const version = tokens(await ask('devinfo version'))[3] || '';
  console.log(`Conectado con ${model} ${version}. Leyendo parámetros (solo lectura)…`);
  out.push(`# Modelo: ${model}  Versión: ${version}`, '');

  const params = [];
  let misses = 0;
  for (let n = 0; misses < 300 && n < 5000; n++) {
    const line = await ask(`prminfo ${n}`);
    if (line.startsWith('OK prminfo')) {
      misses = 0;
      out.push(line);
      const t = tokens(line);
      params.push({ name: t[3], xs: Number(t[4]), ys: Number(t[5]) });
    } else misses++;
    if (n % 100 === 0) process.stdout.write(`\r  ${n} consultados, ${params.length} parámetros`);
  }
  console.log(`\r  ${params.length} parámetros encontrados.                `);

  // Valores actuales de todo lo que parezca vínculo o pareja de canales.
  const linkish = params.filter((p) => /link|pair|gang|stereo/i.test(p.name) && !/Monitor|Meter/i.test(p.name));
  out.push('', '# Valores actuales de parámetros de vínculo', '');
  for (const p of linkish) {
    out.push(`## ${p.name}`);
    const vals = [];
    for (let x = 0; x < Math.min(p.xs || 1, 128); x++) {
      for (let y = 0; y < Math.min(p.ys || 1, 16); y++) {
        const t = tokens(await ask(`get ${p.name} ${x} ${y}`));
        vals.push(`${x},${y}=${t[0] === 'OK' ? t[5] : 'ERR'}`);
      }
    }
    out.push(vals.join('  '), '');
  }

  // Valores de todos los parámetros simples de los canales de entrada (un valor por canal),
  // para descubrir cosas como qué canales están emparejados en estéreo.
  const perChannel = params.filter((p) => p.name.startsWith('MIXER:Current/InCh/') && (p.ys || 1) === 1 && !/Label\/Name/.test(p.name));
  out.push('# Valores por canal de entrada (canal 1 = índice 0)', '');
  let done = 0;
  for (const p of perChannel) {
    const vals = [];
    for (let x = 0; x < Math.min(p.xs || 1, 128); x++) {
      const t = tokens(await ask(`get ${p.name} ${x} 0`));
      vals.push(t[0] === 'OK' ? t[5] : 'ERR');
    }
    out.push(`## ${p.name}`, vals.map((v, x) => `${x + 1}=${v}`).join('  '), '');
    process.stdout.write(`\r  Leyendo valores de canal: ${++done}/${perChannel.length}`);
  }
  console.log('');

  // Direcciones no declaradas que podrían existir (ganancia de recepción Dante / ganancia digital).
  // Solo se consultan con "get": no cambian nada. Se prueban en todos los canales de entrada
  // (o en los indicados con --canales 25,26) para ver en cuáles responde cada una.
  const nCh = (params.find((p) => p.name === 'MIXER:Current/InCh/Fader/Level') || { xs: 72 }).xs;
  const argCh = process.argv.indexOf('--canales');
  const probeCh = argCh > 0 ? process.argv[argCh + 1].split(',').map((n) => Number(n) - 1).filter((n) => n >= 0)
    : Array.from({ length: nCh }, (_, i) => i);
  const candidates = [
    'MIXER:Current/InCh/Port/RxGain', 'MIXER:Current/InCh/Port/Rx/Gain', 'MIXER:Current/InCh/Port/Dante/Gain',
    'MIXER:Current/InCh/Port/Dante/RxGain', 'MIXER:Current/InCh/Port/DigitalGain', 'MIXER:Current/InCh/Port/Gain',
    'MIXER:Current/InCh/Port/GainCompensation/Gain', 'MIXER:Current/InCh/Port/HA/DigitalGain', 'MIXER:Current/InCh/Port/Digital/Gain',
    'MIXER:Current/InCh/DigitalGain', 'MIXER:Current/InCh/Digital/Gain', 'MIXER:Current/InCh/Gain', 'MIXER:Current/InCh/Att',
    'MIXER:Current/InCh/InputGain', 'MIXER:Current/InCh/Input/Gain', 'MIXER:Current/InCh/Input/DigitalGain',
    'IO:Current/InCh/RxGain', 'IO:Current/InCh/DigitalGain', 'IO:Current/InCh/HAGain', 'IO:Current/Dante/RxGain',
    'IO:Current/Dante/Rx/Gain', 'IO:Current/Dante/Gain', 'IO:Current/Dante/In/Gain', 'IO:Current/DanteIn/Gain',
  ];
  // Referencia: en qué canales responde la ganancia HA declarada.
  candidates.unshift('MIXER:Current/InCh/Port/HA/Gain');
  out.push('', '# Direcciones de ganancia probadas en cada canal (solo lectura). Formato: canal=valor, "-" = no responde', '');
  let found = 0, k = 0;
  for (const addr of candidates) {
    const res = [];
    for (const x of probeCh) {
      const t = tokens(await ask(`get ${addr} ${x} 0`));
      res.push(`${x + 1}=${t[0] === 'OK' ? t[5] : '-'}`);
    }
    const hits = res.filter((r) => !r.endsWith('=-')).length;
    if (hits && k > 0) found++;
    out.push(`## ${addr}  (responde en ${hits} de ${probeCh.length} canales)`, hits ? res.join('  ') : '', '');
    process.stdout.write(`\r  Probando direcciones de ganancia: ${++k}/${candidates.length}`);
  }
  console.log(`\n  Direcciones no declaradas que responden: ${found}`);

  // Retención de picos de los medidores de la mesa (ajuste general, no por canal).
  // Nombres probables no declarados; solo se consultan con "get".
  const peakCandidates = [];
  for (const pre of ['MIXER:Setup', 'MIXER:Current']) {
    for (const suf of ['Meter/PeakHold', 'Meter/PeakHold/On', 'Meter/Hold', 'Meter/Hold/On', 'MeterPeakHold', 'Meter/PeakHoldTime',
      'Meter/PeakClear', 'Meter/PeakHoldClear', 'Meter/Peak/Hold', 'Meter/Peak/Clear', 'Preference/PeakHold', 'Preference/Meter/PeakHold',
      'Preference/MeterPeakHold', 'Preferences/PeakHold', 'UserPreference/PeakHold', 'Meter/Fast']) peakCandidates.push(`${pre}/${suf}`);
  }
  peakCandidates.push('SYSTEM:Setup/Meter/PeakHold', 'IO:Setup/Meter/PeakHold', 'IO:Current/Meter/PeakHold');
  out.push('', '# Retención de picos: direcciones probadas (solo lectura)', '');
  let peakFound = 0;
  for (const addr of peakCandidates) {
    const line = await ask(`get ${addr} 0 0`);
    const okLine = line.startsWith('OK');
    if (okLine) peakFound++;
    out.push(`${addr}  |  ${okLine ? 'RESPONDE -> ' + line : 'no'}`);
  }
  // Parámetros declarados cuyo nombre contenga Peak/Hold (por si existieran con otro nombre).
  const declared = params.filter((p) => /peak|hold/i.test(p.name)).map((p) => p.name);
  out.push('', `Parámetros declarados con "Peak" u "Hold" en el nombre: ${declared.length ? declared.join(', ') : 'ninguno'}`);
  console.log(`  Retención de picos: direcciones que responden: ${peakFound} de ${peakCandidates.length}`);

  const file = path.join(__dirname, '..', `parametros-${model.replace(/[^\w-]/g, '')}.txt`);
  fs.writeFileSync(file, out.join('\n'));
  console.log(`\nListo. Archivo guardado en:\n  ${file}\nEnvíaselo a Claude.`);
  sock.end();
  process.exit(0);
});

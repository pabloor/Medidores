// Copia a la versión de escenario (medidores-solo) las partes de la interfaz que comparte con la de sala:
// mensajes y line check (estilos, diálogo, código y textos). La página de escenario no es la misma que la de sala
// (se le quitó el código de control), así que solo se copian los bloques marcados con "compartido:<nombre> (inicio)"
// y "compartido:<nombre> (fin)". En i18n.js cada bloque aparece una vez por idioma y se copian en orden.
// Uso: node medidores/tools/sincronizar-escenario.js              copia los bloques de medidores a medidores-solo
//      node medidores/tools/sincronizar-escenario.js --comprobar  solo comprueba que sean iguales (sale con error si no)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILES = ['public/index.html', 'public/i18n.js'];
const check = process.argv.includes('--comprobar');

// Bloques marcados de un archivo: [{ name, start, end }] (start/end: posiciones del contenido entre las marcas, marcas incluidas)
function blocks(s, file) {
  const out = [];
  const re = /compartido:([a-z0-9-]+) \(inicio\)/g;
  let m;
  while ((m = re.exec(s))) {
    const lineStart = s.lastIndexOf('\n', m.index) + 1;
    const endMark = `compartido:${m[1]} (fin)`;
    const e = s.indexOf(endMark, m.index);
    if (e < 0) throw new Error(`${file}: falta "${endMark}"`);
    const lineEnd = s.indexOf('\n', e) + 1 || s.length;
    out.push({ name: m[1], start: lineStart, end: lineEnd });
    re.lastIndex = lineEnd;
  }
  return out;
}

let changed = 0, differ = 0;
for (const rel of FILES) {
  const src = path.join(ROOT, 'medidores', rel), dst = path.join(ROOT, 'medidores-solo', rel);
  const a = fs.readFileSync(src, 'utf8');
  let b = fs.readFileSync(dst, 'utf8');
  const ba = blocks(a, src), bb = blocks(b, dst);
  const names = (x) => x.map((k) => k.name).join(', ');
  if (names(ba) !== names(bb)) throw new Error(`${rel}: los bloques no coinciden.\n  sala:      ${names(ba)}\n  escenario: ${names(bb)}`);
  // se sustituyen de atrás hacia delante para no mover las posiciones de los que faltan
  for (let k = ba.length - 1; k >= 0; k--) {
    const from = a.slice(ba[k].start, ba[k].end), to = b.slice(bb[k].start, bb[k].end);
    if (from === to) continue;
    differ++;
    console.log(`${rel}: "${ba[k].name}" ${check ? 'es distinto' : 'copiado'}`);
    if (!check) { b = b.slice(0, bb[k].start) + from + b.slice(bb[k].end); changed++; }
  }
  if (!check && changed) fs.writeFileSync(dst, b);
}
if (check && differ) { console.log('La versión de escenario no está al día: ejecuta node medidores/tools/sincronizar-escenario.js'); process.exit(1); }
console.log(check ? 'Sala y escenario tienen los mismos bloques compartidos.' : changed ? `${changed} bloques copiados a medidores-solo.` : 'Ya estaban iguales.');

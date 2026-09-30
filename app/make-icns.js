// Genera un .icns a partir de PNG (node app/make-icns.js salida.icns 128.png 256.png 512.png 1024.png)
const fs = require('fs');
const TYPES = { 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
const [out, ...pngs] = process.argv.slice(2);
const chunks = pngs.map((f) => {
  const data = fs.readFileSync(f);
  const size = data.readUInt32BE(16); // ancho del PNG (cabecera IHDR)
  const head = Buffer.alloc(8);
  head.write(TYPES[size], 0, 'ascii');
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
const head = Buffer.alloc(8);
head.write('icns', 0, 'ascii');
head.writeUInt32BE(total, 4);
fs.writeFileSync(out, Buffer.concat([head, ...chunks]));

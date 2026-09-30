// node app/make-icon-pngs.js icon.svg carpeta-salida  -> 128/256/512/1024.png
const sharp = require('sharp');
const fs = require('fs');
const [svg, dir] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
(async () => {
  for (const s of [128, 256, 512, 1024]) await sharp(svg, { density: 384 }).resize(s, s).png().toFile(`${dir}/${s}.png`);
})();

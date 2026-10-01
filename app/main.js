// Arranque mínimo de Medidores.app. Elige qué código ejecutar:
//  - el que trae la app (Resources/app), o
//  - una actualización descargada en ~/Library/Application Support/medidores-app/update/current, si es más nueva.
// La actualización vive fuera de la .app, así que la firma de la app no se toca.
// Si una actualización falla al arrancar (error, o 2 arranques sin llegar a funcionar), se descarta y se vuelve al código incluido.
// Este archivo debe cambiar lo menos posible: no se actualiza solo.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch {} };
const versionOf = (dir) => { const v = readJson(path.join(dir, 'version.json')); return v && typeof v.version === 'string' ? v.version : null; };
const newer = (a, b) => a > b; // versiones tipo 20260930-2357: el orden alfabético es el cronológico

const root = path.join(app.getPath('userData'), 'update');
const current = path.join(root, 'current');
const bootFile = path.join(root, 'boot.json');   // { version, attempts }: intentos de arranque sin llegar a funcionar
const badFile = path.join(root, 'bad.json');     // { versions: [] }: actualizaciones descartadas (no se vuelven a bajar)

function discard(version) {
  try { fs.rmSync(current, { recursive: true, force: true }); } catch {}
  const bad = readJson(badFile) || { versions: [] };
  if (version && !bad.versions.includes(version)) bad.versions.push(version);
  writeJson(badFile, bad);
  writeJson(bootFile, { version: null, attempts: 0 });
}

function chooseDir() {
  const bundledV = versionOf(__dirname);
  const updV = versionOf(current);
  if (!updV || !fs.existsSync(path.join(current, 'app-main.js'))) return __dirname;
  if (bundledV && !newer(updV, bundledV)) { try { fs.rmSync(current, { recursive: true, force: true }); } catch {} return __dirname; }
  const boot = readJson(bootFile) || {};
  const attempts = boot.version === updV ? boot.attempts || 0 : 0;
  if (attempts >= 2) { discard(updV); return __dirname; }
  writeJson(bootFile, { version: updV, attempts: attempts + 1 });
  return current;
}

let dir = chooseDir();
try {
  require(path.join(dir, 'app-main.js'));
} catch (err) {
  console.error('La actualización no ha podido arrancar:', err);
  if (dir !== __dirname) {
    discard(versionOf(dir));
    dir = __dirname;
    require(path.join(dir, 'app-main.js'));
  } else throw err;
}

// Actualizaciones de Medidores.app: baja el código nuevo (update.tar.gz) de la última release de GitHub
// y lo deja en userData/update/current. Se estrena en el siguiente arranque.
// Solo cambia el código de la app (servidores, interfaz, menú), no el Electron de dentro: si hiciera falta
// un Electron nuevo, habría que volver a instalar la app entera.
const { app, net } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Dos canales (version.json → channel):
//  - estable (Medidores): la release marcada como la última ("latest", tag mac-…). GitHub nunca da como última una pre-release.
//  - pruebas (Medidores Pruebas): la pre-release más reciente con tag pruebas-…. Así lo que se sube para probar no llega a quien
//    usa la app normal, y la de pruebas no se cambia por la normal.
const CHANNEL = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).channel || 'estable'; } catch { return 'estable'; } })();
const REPO = 'https://api.github.com/repos/pabloor/Medidores';
const API = process.env.MEDIDORES_UPDATE_API || (CHANNEL === 'pruebas' ? `${REPO}/releases?per_page=30` : `${REPO}/releases/latest`);
const TAG = CHANNEL === 'pruebas' ? /^pruebas-/ : /^mac-/;
const root = () => path.join(app.getPath('userData'), 'update');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const tarX = (file, dir) => new Promise((res, rej) => execFile('tar', ['-xzf', file, '-C', dir], (e) => (e ? rej(e) : res())));

async function getJson(url) {
  const r = await net.fetch(url, { headers: { 'User-Agent': 'Medidores-app', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub respondió ${r.status}`);
  return r.json();
}

// Devuelve { status: 'uptodate' | 'staged' | 'error', version, message }.
// `running`: versión que se está ejecutando ahora. Con una actualización ya preparada, no vuelve a bajarla.
async function checkForUpdate(running) {
  try {
    const got = await getJson(API);
    const rel = (Array.isArray(got) ? got.filter((r) => TAG.test(r.tag_name || '') && !r.draft).sort((a, b) => String(b.tag_name).localeCompare(String(a.tag_name)))[0] : got) || {};
    if (!TAG.test(rel.tag_name || '')) return { status: 'uptodate', version: running };
    const version = String(rel.tag_name || '').replace(TAG, '');
    const asset = (rel.assets || []).find((a) => a.name === 'update.tar.gz');
    if (!version || !asset) return { status: 'uptodate', version: running };
    if (!(version > running)) return { status: 'uptodate', version: running };
    const bad = readJson(path.join(root(), 'bad.json'));
    if (bad && bad.versions.includes(version)) return { status: 'uptodate', version: running };
    const staged = readJson(path.join(root(), 'current', 'version.json'));
    if (staged && staged.version === version) return { status: 'staged', version };

    const tmp = path.join(root(), 'tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'app'), { recursive: true });
    const r = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'Medidores-app' } });
    if (!r.ok) throw new Error(`No se pudo descargar la actualización (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    const want = String(asset.digest || '').replace(/^sha256:/, '');
    if (want && crypto.createHash('sha256').update(buf).digest('hex') !== want) throw new Error('La descarga está corrupta');
    const file = path.join(tmp, 'update.tar.gz');
    fs.writeFileSync(file, buf);
    await tarX(file, path.join(tmp, 'app'));
    const v = readJson(path.join(tmp, 'app', 'version.json'));
    if (!v || v.version !== version || !fs.existsSync(path.join(tmp, 'app', 'app-main.js'))) throw new Error('La actualización no es válida');
    // Sustitución: la anterior se borra y la nueva pasa a ser "current".
    fs.rmSync(path.join(root(), 'current'), { recursive: true, force: true });
    fs.renameSync(path.join(tmp, 'app'), path.join(root(), 'current'));
    fs.rmSync(tmp, { recursive: true, force: true });
    return { status: 'staged', version };
  } catch (e) {
    return { status: 'error', message: String((e && e.message) || e) };
  }
}

module.exports = { checkForUpdate };

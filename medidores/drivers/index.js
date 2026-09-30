// Registro de drivers. Para añadir otra marca: crea drivers/<marca>.js con la misma
// interfaz (start, stop y eventos 'status', 'layout', 'levels', 'raw') y regístrala aquí.
const Behringer = require('./behringer');
const Simulator = require('./simulator');
const Yamaha = require('./yamaha');
const DiGiCo = require('./digico');

const DRIVERS = {
  auto: Behringer, x32: Behringer, m32: Behringer, xair: Behringer, xr: Behringer, mr: Behringer,
  yamaha: Yamaha,
  digico: DiGiCo,
  sim: Simulator,
};

function createDriver(name, opts) {
  const D = DRIVERS[name];
  if (!D) throw new Error(`Driver desconocido: "${name}". Opciones: ${Object.keys(DRIVERS).join(', ')}`);
  return new D({ ...opts, driver: name });
}

module.exports = { createDriver };

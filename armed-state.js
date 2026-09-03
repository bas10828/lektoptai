const fs = require('fs');
const path = require('path');

// Persists each camera's live armed/disarmed state to disk so a power loss
// or restart comes back exactly as it was left, instead of resetting to
// config.js's armedDefault every time. mode.js's own state (away/home/
// custom) is saved separately in mode-state.json — this file only covers
// the per-camera booleans that "custom" mode leaves under manual control.
function createArmedStateStore(dataDir) {
  const statePath = path.join(dataDir, 'armed-state.json');

  let state = { noParking: null, intrusion: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state = { noParking: typeof saved.noParking === 'boolean' ? saved.noParking : null, intrusion: saved.intrusion || {} };
  } catch (e) { /* no saved state yet — keep default */ }

  function persist() {
    fs.writeFile(statePath, JSON.stringify(state), () => {});
  }

  return {
    getNoParking: (fallback) => (typeof state.noParking === 'boolean' ? state.noParking : fallback),
    setNoParking(armed) { state.noParking = armed; persist(); },
    getIntrusion: (camId, fallback) => (typeof state.intrusion[camId] === 'boolean' ? state.intrusion[camId] : fallback),
    setIntrusion(camId, armed) { state.intrusion[camId] = armed; persist(); },
  };
}

module.exports = { createArmedStateStore };

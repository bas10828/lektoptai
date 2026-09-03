const fs = require('fs');
const path = require('path');

// House-wide arm/disarm presets, covering all 5 cameras (1 front + 4 back).
//   away   - full system: front armed + all 4 back-house cams armed, always
//   home   - front armed; back-house armed only NIGHT_START_HOUR..NIGHT_END_HOUR
//   custom - hands-off; whatever each camera's own toggle is set to stands
//
// Front (no-parking) and back (intrusion) are enforced differently on
// purpose. Back-house re-asserts on every tick (CHECK_INTERVAL_MS) so "away"
// stays fully armed and "home" tracks the night-window boundary live. Front
// is only forced armed once, at the moment the user switches INTO away or
// home — after that a manual disarm from the /no-parking page sticks until
// the next mode switch, per "เปิดตลอด เว้นแต่สั่งปิดเอง" (on by default,
// off only if turned off by hand). If front were re-asserted every tick too,
// that manual override would silently revert within a minute.
//
// Fixed clock times, not sunset-calculated — tried an astronomical
// (NOAA-equation) sunset calc first, but a fixed number was preferred: it
// stays predictable year-round instead of drifting with the season.
const NIGHT_START_HOUR = 19; // 19:00
const NIGHT_END_HOUR = 6;    // 06:00 (exclusive) — spans midnight
const CHECK_INTERVAL_MS = 60 * 1000;
const VALID_MODES = ['away', 'home', 'custom'];

function isNightNow() {
  const h = new Date().getHours();
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

function createModeController({ intrusion, noParking, dataDir }) {
  const statePath = path.join(dataDir, 'mode-state.json');

  let mode = 'custom'; // safe default: no auto arm/disarm until the user actually picks a mode
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (VALID_MODES.includes(saved.mode)) mode = saved.mode;
  } catch (e) { /* no saved state yet — keep default */ }

  function persist() {
    fs.writeFile(statePath, JSON.stringify({ mode }), () => {});
  }

  // Continuous enforcement — back-house only. Runs every tick so "away"
  // stays fully armed even if a camera got manually disarmed earlier, and
  // "home" crosses the night-window boundary on its own without a restart.
  function tick() {
    if (mode === 'away') intrusion.setAllArmed(true, 'mode-away');
    else if (mode === 'home') intrusion.setAllArmed(isNightNow(), 'mode-home');
    // custom: no-op — per-camera toggles are the user's own call
  }

  // Front camera: forced armed once, on entering away/home — NOT
  // re-asserted on every tick (see module comment above for why).
  function forceFrontOnEntry() {
    if (mode === 'away' || mode === 'home') noParking.setArmed(true, `mode-${mode}`);
  }

  function setMode(next) {
    if (!VALID_MODES.includes(next)) throw new Error('unknown mode');
    mode = next;
    persist();
    tick();
    forceFrontOnEntry();
  }

  function status() {
    return { mode, isNight: isNightNow(), nightStartHour: NIGHT_START_HOUR, nightEndHour: NIGHT_END_HOUR };
  }

  // Boot-time: re-enter the saved mode exactly like a fresh switch into it
  // (back-house synced, front forced on once for away/home).
  tick();
  forceFrontOnEntry();
  setInterval(tick, CHECK_INTERVAL_MS);

  return { setMode, status };
}

module.exports = { createModeController };

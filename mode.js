const fs = require('fs');
const path = require('path');
const { inWindow } = require('./cam-settings');

// House-wide arm/disarm presets, covering all 5 cameras (1 front + 4 back).
//   away   - full system: front armed + all 4 back-house cams armed, always
//   home   - front armed; back-house armed only NIGHT_START_HOUR..NIGHT_END_HOUR
//   custom - per back-house camera (cam-settings.js): schedule 'manual'
//            leaves that camera's own toggle alone (the original custom
//            behaviour); schedule 'window' arms it inside its own start..end
//            window and disarms it outside, with the same sticky rule as
//            "home" below. The front camera is never touched in custom.
//
// Front (no-parking) and back (intrusion) are both sticky the same way: a
// manual disarm holds until the next real boundary, not re-forced on every
// tick. Front's only boundary is a mode switch (forced once on entry to
// away/home). Back-house has one more boundary — "home"'s night-window
// clock — so it's re-checked every tick (CHECK_INTERVAL_MS) but only
// re-asserts when the mode actually just changed or the night/day value
// actually just flipped, never unconditionally. (Back-house used to force
// its value on literally every tick regardless, which fought a manual
// disarm from the /intrusion page — it reverted within 60s. Per
// "เปิดตลอด เว้นแต่สั่งปิดเอง", on by default, off only if turned off by
// hand — that has to hold for back-house too.)
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

function createModeController({ intrusion, noParking, camSettings, dataDir }) {
  const statePath = path.join(dataDir, 'mode-state.json');

  let mode = 'custom'; // safe default: no auto arm/disarm until the user actually picks a mode
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (VALID_MODES.includes(saved.mode)) mode = saved.mode;
  } catch (e) { /* no saved state yet — keep default */ }

  function persist() {
    fs.writeFile(statePath, JSON.stringify({ mode }), () => {});
  }

  // Back-house enforcement. Used to re-assert on EVERY tick regardless of
  // anything else, which fought a manual disarm from the /intrusion page —
  // it silently reverted within 60s of being turned off by hand ("away"
  // always forced true, "home" forced true any time isNightNow() was true),
  // making manual disarm useless overnight and firing constant false
  // alarms in production. Fixed to only force a value at an actual
  // boundary — entering away/home, or "home"'s night-window flipping — same
  // sticky-until-the-next-real-change principle as front-house below,
  // just with an extra boundary (the night clock) that front doesn't have.
  let lastMode = null;
  let lastNight = null;
  // custom: last schedule-derived value per camera, and cameras whose
  // settings were just saved (a save is itself a boundary for that camera).
  const lastWanted = new Map();
  const dirty = new Set();
  function tick() {
    const night = isNightNow();
    const modeChanged = mode !== lastMode;
    if (mode === 'away') {
      if (modeChanged) intrusion.setAllArmed(true, 'mode-away');
    } else if (mode === 'home') {
      if (modeChanged || night !== lastNight) intrusion.setAllArmed(night, 'mode-home');
    } else if (mode === 'custom') {
      for (const camId of intrusion.camIds()) {
        const s = camSettings.get(camId);
        if (s.schedule !== 'window') { lastWanted.delete(camId); continue; }
        const want = inWindow(s.start, s.end);
        if (modeChanged || dirty.has(camId) || want !== lastWanted.get(camId)) {
          intrusion.setArmed(camId, want, 'mode-custom');
        }
        lastWanted.set(camId, want);
      }
    }
    if (mode !== 'custom') lastWanted.clear();
    dirty.clear();
    lastMode = mode;
    lastNight = night;
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

  intrusion.onSettingsChanged((camId) => {
    dirty.add(camId);
    tick();
  });

  // Boot-time: re-enter the saved mode exactly like a fresh switch into it
  // (back-house synced, front forced on once for away/home).
  tick();
  forceFrontOnEntry();
  setInterval(tick, CHECK_INTERVAL_MS);

  return { setMode, status };
}

module.exports = { createModeController };

const fs = require('fs');
const path = require('path');

// Per-camera settings for the back-house cameras, persisted next to
// armed-state.json (bind-mounted in Docker, so it survives recreates).
//   schedule    - 'manual': hands-off, the camera's own toggle stands (the
//                 original "custom" behaviour, and the default)
//                 'window': armed between start..end, disarmed outside it.
//                 Only applied while mode.js is in "custom" mode.
//   start/end   - "HH:MM", Asia/Bangkok wall-clock time; may span midnight
//   volume      - speaker volume 0-100 used by the warning loop
//   cooldownMin - after a camera-triggered warning ends, ignore further
//                 detections for this many minutes (no sound AND no
//                 warning-start log line, so no LINE alert either)
const SCHEDULES = ['manual', 'window'];
const COOLDOWNS = [0, 1, 5, 15];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Explicit timezone, not getHours(): the Docker image has no TZ set, so the
// process clock may be UTC on the deploy host.
const TIME_ZONE = 'Asia/Bangkok';
const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function minutesOfDay(date) {
  const parts = clockFmt.formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// [start, end) — a window whose end is earlier than its start spans midnight.
function inWindow(start, end, date = new Date()) {
  const now = minutesOfDay(date);
  const s = toMinutes(start);
  const e = toMinutes(end);
  return s < e ? now >= s && now < e : now >= s || now < e;
}

function defaults(volume) {
  return { schedule: 'manual', start: '19:00', end: '06:00', volume, cooldownMin: 0 };
}

function validate(input) {
  const out = {};
  if ('schedule' in input) {
    if (!SCHEDULES.includes(input.schedule)) throw new Error('schedule must be manual or window');
    out.schedule = input.schedule;
  }
  for (const k of ['start', 'end']) {
    if (k in input) {
      if (typeof input[k] !== 'string' || !HHMM.test(input[k])) throw new Error(`${k} must be HH:MM`);
      out[k] = input[k];
    }
  }
  if ('volume' in input) {
    const v = input.volume;
    if (!Number.isInteger(v) || v < 0 || v > 100) throw new Error('volume must be an integer 0-100');
    out.volume = v;
  }
  if ('cooldownMin' in input) {
    if (!COOLDOWNS.includes(input.cooldownMin)) throw new Error(`cooldownMin must be one of ${COOLDOWNS.join(', ')}`);
    out.cooldownMin = input.cooldownMin;
  }
  return out;
}

function createCamSettingsStore(dataDir, camConfigs) {
  const statePath = path.join(dataDir, 'cam-settings.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {}; } catch (e) { /* none yet */ }

  const settings = {};
  for (const cfg of camConfigs) {
    const base = defaults(cfg.speakerVolume);
    let s = base;
    try { s = { ...base, ...validate(saved[cfg.id] || {}) }; } catch (e) {
      console.error(`[cam-settings] ignoring invalid saved settings for ${cfg.id}:`, e.message);
    }
    settings[cfg.id] = s;
  }

  function persist() {
    fs.writeFile(statePath, JSON.stringify(settings, null, 2), () => {});
  }

  return {
    get: (camId) => ({ ...settings[camId] }),
    all: () => JSON.parse(JSON.stringify(settings)),
    update(camId, input) {
      if (!settings[camId]) throw new Error('unknown camId');
      const next = { ...settings[camId], ...validate(input || {}) };
      if (next.schedule === 'window' && next.start === next.end) throw new Error('start and end must differ');
      settings[camId] = next;
      persist();
      return { ...next };
    },
  };
}

module.exports = { createCamSettingsStore, inWindow, minutesOfDay, TIME_ZONE, COOLDOWNS };

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const { createCamSettingsStore, inWindow } = require('../cam-settings');
const { createModeController } = require('../mode');

// mode.js starts a 60s setInterval on creation; mock it so the test process
// can exit.
test.mock.timers.enable({ apis: ['setInterval'] });

const CAM_IDS = ['intr1', 'intr2', 'intr3'];

function setup({ savedMode, savedSettings } = {}) {
  const dir = tmpDir();
  if (savedMode) fs.writeFileSync(path.join(dir, 'mode-state.json'), JSON.stringify({ mode: savedMode }));
  if (savedSettings) fs.writeFileSync(path.join(dir, 'cam-settings.json'), JSON.stringify(savedSettings));
  const camSettings = createCamSettingsStore(dir, CAM_IDS.map((id) => ({ id, speakerVolume: 100 })));
  const calls = [];
  let settingsListener = null;
  const intrusion = {
    camIds: () => CAM_IDS,
    setAllArmed: (armed, source) => calls.push(['all', armed, source]),
    setArmed: (camId, armed, source) => calls.push(['one', camId, armed, source]),
    onSettingsChanged: (fn) => { settingsListener = fn; },
  };
  const noParking = { setArmed: (armed, source) => calls.push(['front', armed, source]) };
  const mode = createModeController({ intrusion, noParking, camSettings, dataDir: dir });
  const save = (camId, input) => { camSettings.update(camId, input); settingsListener(camId); };
  return { calls, mode, save };
}

// Almost always "on"; the expected armed value is computed with the same
// function so the one off-minute (23:59) can't make the test flaky.
const ALWAYS_ON = { schedule: 'window', start: '00:00', end: '23:59' };
const ON = inWindow(ALWAYS_ON.start, ALWAYS_ON.end);

test('away: on boot arms all back cams and the front, once', () => {
  const { calls } = setup({ savedMode: 'away' });
  assert.deepEqual(calls, [['all', true, 'mode-away'], ['front', true, 'mode-away']]);
});

test('home: on boot sets back cams to the night value and arms the front', () => {
  const { calls } = setup({ savedMode: 'home' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'all');
  assert.equal(calls[0][2], 'mode-home');
  assert.deepEqual(calls[1], ['front', true, 'mode-home']);
});

test('custom (default) with all cams manual touches nothing', () => {
  const { calls } = setup();
  assert.deepEqual(calls, []);
});

test('custom boot re-asserts only window cams, never the front', () => {
  const { calls } = setup({ savedMode: 'custom', savedSettings: { intr2: ALWAYS_ON } });
  assert.deepEqual(calls, [['one', 'intr2', ON, 'mode-custom']]);
});

test('custom: saving one camera touches only that camera', () => {
  const t = setup({ savedMode: 'custom' });
  t.save('intr1', ALWAYS_ON);
  assert.deepEqual(t.calls, [['one', 'intr1', ON, 'mode-custom']]);
  t.calls.length = 0;
  t.save('intr3', { volume: 40 }); // manual camera: volume only
  assert.deepEqual(t.calls, []);
});

test('saving a schedule while in away mode does not enforce it', () => {
  const t = setup({ savedMode: 'away' });
  t.calls.length = 0;
  t.save('intr1', ALWAYS_ON);
  assert.deepEqual(t.calls, []);
});

test('switching away -> custom asserts the window cams', () => {
  const t = setup({ savedMode: 'away', savedSettings: { intr1: ALWAYS_ON, intr3: ALWAYS_ON } });
  t.calls.length = 0;
  t.mode.setMode('custom');
  assert.deepEqual(t.calls.map((c) => c[1]).sort(), ['intr1', 'intr3']);
});

test('setMode rejects unknown modes', () => {
  const t = setup();
  assert.throws(() => t.mode.setMode('party'));
});

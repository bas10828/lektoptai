const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const { inWindow, createCamSettingsStore } = require('../cam-settings');

// A Date at the given Asia/Bangkok wall-clock time (UTC+7, no DST).
const bkk = (hh, mm) => new Date(Date.UTC(2026, 8, 30, hh - 7, mm));

test('inWindow: window spanning midnight, start inclusive / end exclusive', () => {
  assert.equal(inWindow('19:00', '06:00', bkk(18, 59)), false);
  assert.equal(inWindow('19:00', '06:00', bkk(19, 0)), true);
  assert.equal(inWindow('19:00', '06:00', bkk(23, 30)), true);
  assert.equal(inWindow('19:00', '06:00', bkk(2, 0)), true);
  assert.equal(inWindow('19:00', '06:00', bkk(5, 59)), true);
  assert.equal(inWindow('19:00', '06:00', bkk(6, 0)), false);
});

test('inWindow: same-day window', () => {
  assert.equal(inWindow('08:00', '17:00', bkk(7, 59)), false);
  assert.equal(inWindow('08:00', '17:00', bkk(8, 0)), true);
  assert.equal(inWindow('08:00', '17:00', bkk(16, 59)), true);
  assert.equal(inWindow('08:00', '17:00', bkk(17, 0)), false);
});

test('inWindow uses Bangkok time regardless of the process timezone', () => {
  // 12:00 UTC is 19:00 in Bangkok — inside a 19:00-06:00 window.
  assert.equal(inWindow('19:00', '06:00', new Date(Date.UTC(2026, 8, 30, 12, 0))), true);
});

test('store: defaults to manual schedule and the config speaker volume', () => {
  const store = createCamSettingsStore(tmpDir(), [{ id: 'intr1', speakerVolume: 90 }]);
  assert.deepEqual(store.get('intr1'), { schedule: 'manual', start: '19:00', end: '06:00', volume: 90, cooldownMin: 0 });
});

test('store: update validates and persists', () => {
  const dir = tmpDir();
  const cams = [{ id: 'intr1', speakerVolume: 100 }];
  const store = createCamSettingsStore(dir, cams);
  store.update('intr1', { schedule: 'window', start: '22:00', end: '06:00', volume: 40, cooldownMin: 5 });

  for (const bad of [
    { volume: 101 }, { volume: -1 }, { volume: 50.5 },
    { cooldownMin: 3 }, { start: '25:00' }, { end: '7:00' },
    { schedule: 'always' }, { schedule: 'window', start: '10:00', end: '10:00' },
  ]) {
    assert.throws(() => store.update('intr1', bad), undefined, JSON.stringify(bad));
  }
  assert.throws(() => store.update('nope', { volume: 10 }));

  // persist() writes asynchronously
  return new Promise((resolve) => setTimeout(() => {
    const reloaded = createCamSettingsStore(dir, cams);
    assert.deepEqual(reloaded.get('intr1'), { schedule: 'window', start: '22:00', end: '06:00', volume: 40, cooldownMin: 5 });
    resolve();
  }, 100));
});

test('store: ignores an invalid saved file entry instead of crashing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'cam-settings.json'), JSON.stringify({ intr1: { volume: 999 } }));
  const store = createCamSettingsStore(dir, [{ id: 'intr1', speakerVolume: 100 }]);
  assert.equal(store.get('intr1').volume, 100);
});

// Back-house channel, including the event-log contract the external LINE
// watcher on the server depends on (it tails intrusion-events.log and alerts
// on phase "warning-start"; source "camera" = real, "manual" = test; camId
// says which camera). If one of the contract tests here fails, LINE alerts
// would silently break in production — tell the server side before changing
// the expectation.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { stubModule, tmpDir, sleep, readLog, request } = require('./helpers');

const hw = [];
const subscribers = {};
stubModule('camera-client.js', {
  auth: async () => 'stok',
  subscribe: (cfg, stok, types, heartbeat, onEvent) => { subscribers[cfg.id] = onEvent; },
  setSpeakerVolume: async (cfg, v) => hw.push(['volume', cfg.id, v]),
  manualAlarm: async (cfg, act) => hw.push(['siren', cfg.id, act]),
});
stubModule('talk-client.js', { playOnCamera: async (cfg) => { hw.push(['play', cfg.id]); await sleep(30); } });
stubModule('video-stream.js', { startMjpegStream: () => ({ msSinceLastFrame: () => 0, switchTo() {} }) });

const { createIntrusionChannel } = require('../channels/intrusion');
const { createCamSettingsStore } = require('../cam-settings');

function setup() {
  const dir = tmpDir();
  const cfgs = ['intr1', 'intr2'].map((id) => ({
    id, label: id, camIp: '192.0.2.1', speakerVolume: 100,
    entryEventType: 'MotionDetection_people_enhance', heartbeatSec: 15,
    warningFiles: ['warning.alaw'], presenceTimeoutMs: 50, maxLoopMs: 1000, sirenMs: 1,
    armedDefault: true,
  }));
  const camSettings = createCamSettingsStore(dir, cfgs);
  const channel = createIntrusionChannel(cfgs, dir, { setIntrusion() {} }, camSettings);
  channel.start();
  return { channel, logFile: path.join(dir, 'intrusion-events.log') };
}

const detect = (camId) => subscribers[camId]({ event_type: 'MotionDetection_people_enhance' });
const starts = (log) => log.filter((l) => l.phase === 'warning-start');

test('CONTRACT: a real detection logs warning-start with source camera + camId', async () => {
  const { logFile } = setup();
  await sleep(10);
  detect('intr1');
  await sleep(250);
  const [line] = starts(await readLog(logFile));
  assert.ok(line, 'no warning-start written');
  assert.deepEqual(Object.keys(line).sort(), ['camId', 'phase', 'source', 'ts']);
  assert.equal(line.source, 'camera');
  assert.equal(line.camId, 'intr1');
  assert.ok(!Number.isNaN(Date.parse(line.ts)), 'ts must be an ISO timestamp');
});

test('CONTRACT: the siren test logs warning-start with source manual', async () => {
  const { channel, logFile } = setup();
  const r = await request(channel, 'POST', '/test-alarm', { camId: 'intr2' });
  assert.equal(r.code, 200);
  await sleep(250);
  const [line] = starts(await readLog(logFile));
  assert.deepEqual({ source: line.source, camId: line.camId }, { source: 'manual', camId: 'intr2' });
});

test('CONTRACT: /state keeps selectedCamId and per-camera ids', async () => {
  const { channel } = setup();
  const snap = channel.allSnapshot();
  assert.equal(snap.selectedCamId, 'intr1');
  assert.deepEqual(snap.cams.map((c) => c.id), ['intr1', 'intr2']);
});

test('saved volume is applied to the warning loop', async () => {
  const { channel } = setup();
  await request(channel, 'POST', '/settings', { camId: 'intr1', volume: 40 });
  hw.length = 0;
  detect('intr1');
  await sleep(250);
  assert.ok(hw.some(([k, id, v]) => k === 'volume' && id === 'intr1' && v === 40));
});

test('cooldown suppresses the next camera alert (and its LINE line) only for that camera', async () => {
  const { channel, logFile } = setup();
  await request(channel, 'POST', '/settings', { camId: 'intr1', cooldownMin: 5 });
  detect('intr1');
  await sleep(250);
  assert.ok(channel.allSnapshot().cams[0].cooldownUntil > Date.now());
  detect('intr1');
  detect('intr2');
  await sleep(250);
  const log = starts(await readLog(logFile));
  assert.equal(log.filter((l) => l.camId === 'intr1').length, 1);
  assert.equal(log.filter((l) => l.camId === 'intr2').length, 1);
});

test('settings endpoint rejects invalid input', async () => {
  const { channel } = setup();
  assert.equal((await request(channel, 'POST', '/settings', { camId: 'intr1', volume: 400 })).code, 400);
  assert.equal((await request(channel, 'POST', '/settings', { camId: 'nope', volume: 10 })).code, 400);
});

test('voice test: speaker only — no siren, no event-log line, one at a time', async () => {
  const { channel, logFile } = setup();
  hw.length = 0;
  const first = request(channel, 'POST', '/test-voice', { camId: 'intr2', volume: 70 });
  const second = await request(channel, 'POST', '/test-voice', { camId: 'intr2' });
  assert.equal(second.code, 400, 'concurrent voice test must be refused');
  assert.equal((await first).code, 200);
  assert.deepEqual(hw, [['volume', 'intr2', 70], ['play', 'intr2']]);
  assert.deepEqual(await readLog(logFile), []);
});

test('setArmed (schedules) logs disarmed with source mode-custom', async () => {
  const { channel, logFile } = setup();
  channel.setArmed('intr1', false, 'mode-custom');
  const last = (await readLog(logFile)).pop();
  assert.deepEqual({ camId: last.camId, phase: last.phase, source: last.source }, { camId: 'intr1', phase: 'disarmed', source: 'mode-custom' });
  assert.equal(channel.allSnapshot().cams[0].armed, false);
});

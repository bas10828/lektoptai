// Front channel event-log contract for the external LINE watcher (it tails
// no-parking-events.log and alerts on phase "warning-start"; source "camera"
// = real, "manual" = test). If these fail, tell the server side before
// changing the expectation.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { stubModule, tmpDir, sleep, readLog, request } = require('./helpers');

stubModule('camera-client.js', {
  auth: async () => 'stok',
  setSpeakerVolume: async () => {},
  manualAlarm: async () => {},
});
stubModule('talk-client.js', { playOnCamera: async () => { await sleep(20); } });
stubModule('video-stream.js', { startMjpegStream: () => ({ msSinceLastFrame: () => 0 }) });
let detectorOpts = null;
let occupied = false;
stubModule('yolo-detector.js', {
  startVehicleDetector: (id, opts) => {
    detectorOpts = opts;
    return { getZone: () => opts.zone, isReady: () => true, isOccupied: () => occupied, setZone() {} };
  },
});

const { createNoParkingChannel } = require('../channels/no-parking');

function setup() {
  const dir = tmpDir();
  const cfg = {
    id: 'front', label: 'front', camIp: '192.0.2.2', speakerVolume: 100, sirenMs: 1,
    maxLoopMsToggle: 200, warningFilesVehicle: ['v.alaw'], armedDefault: true,
  };
  const channel = createNoParkingChannel(cfg, dir, { setNoParking() {} });
  channel.start();
  return { channel, logFile: path.join(dir, 'no-parking-events.log') };
}

test('CONTRACT: a real parked-vehicle alarm logs warning-start with source camera', async () => {
  const { logFile } = setup();
  occupied = true;
  detectorOpts.onOccupiedChange(true, { cls: 'car', conf: 0.9 });
  occupied = false;
  await sleep(300);
  const line = (await readLog(logFile)).find((l) => l.phase === 'warning-start');
  assert.ok(line, 'no warning-start written');
  assert.deepEqual(Object.keys(line).sort(), ['phase', 'source', 'ts']);
  assert.equal(line.source, 'camera');
});

test('CONTRACT: the siren test logs warning-start with source manual', async () => {
  const { channel, logFile } = setup();
  const r = await request(channel, 'POST', '/test-alarm');
  assert.equal(r.code, 200);
  await sleep(300);
  const line = (await readLog(logFile)).find((l) => l.phase === 'warning-start');
  assert.equal(line.source, 'manual');
});

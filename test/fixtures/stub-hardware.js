// Preloaded with `node -r` in front of server.js by server.test.js: replaces
// every module that talks to real hardware with an inert stub, so a real
// server instance can be started in tests without contacting a camera, the
// NVR, ffmpeg or the YOLO worker. (Also picked up as a "test file" by
// `node --test`'s default glob; requiring it there is harmless.)
const path = require('path');

const APP = path.join(__dirname, '..', '..');
function stub(rel, exportsObj) {
  const file = require.resolve(path.join(APP, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}

stub('camera-client.js', {
  auth: async () => 'stok',
  call: async () => ({ errCode: 0 }),
  callAuthed: async () => ({ errCode: 0 }),
  subscribe: () => {},
  setSpeakerVolume: async () => {},
  manualAlarm: async () => {},
});
stub('talk-client.js', { playOnCamera: async () => {} });
stub('video-stream.js', { startMjpegStream: () => ({ msSinceLastFrame: () => 0, switchTo() {} }) });
stub('yolo-detector.js', {
  startVehicleDetector: (id, opts) => ({ getZone: () => opts.zone, isReady: () => false, isOccupied: () => false, setZone() {} }),
});
stub('nvr-client.js', { getChannelNamesByIp: async () => new Map() });

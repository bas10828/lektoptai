const fs = require('fs');
const path = require('path');
const cam = require('../camera-client');
const { playOnCamera } = require('../talk-client');
const { startMjpegStream } = require('../video-stream');
const { startVehicleDetector } = require('../yolo-detector');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Creates the no-parking (YOLO) channel: its own camera connection, MJPEG
// preview, YOLO worker, and warning-loop state — mounted under `/no-parking`
// by server.js. Ported near-verbatim from the standalone
// vehicle-yolo-detector/server.js, just wrapped as a module instead of
// owning its own http.Server.
function createNoParkingChannel(cfg, dataDir, armedStateStore) {
  const eventLogPath = path.join(dataDir, 'no-parking-events.log');
  function logEvent(entry) {
    fs.appendFile(eventLogPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', () => {});
  }

  const zoneSettingsPath = path.join(dataDir, 'no-parking-zone-settings.json');
  function loadZoneSettings() {
    try { return JSON.parse(fs.readFileSync(zoneSettingsPath, 'utf8')); }
    catch (e) { return { zone: [77, 87, 483, 358], zonePoints: null }; }
  }
  function saveZoneSettings(zone, zonePoints) {
    fs.writeFileSync(zoneSettingsPath, JSON.stringify({ zone, zonePoints: zonePoints || null }, null, 1));
  }

  const state = { armed: cfg.armedDefault, running: false, alertCount: 0, lastAlertAt: null, recentAlerts: [] };
  let latestFrame = null;
  let latestDetections = [];
  let vehicleDetector = null;
  let currentZonePoints = null;
  let videoController = null;

  const sseClients = new Set();
  const mjpegClients = new Set();
  const MJPEG_BOUNDARY = 'noparkingboundary';
  // MJPEG in an <img> never fires load/error again on a silent stall, so
  // the video just freezes with no visual cue anything's wrong — surface an
  // explicit offline flag instead of letting that pass for "everything's
  // fine" (the ffmpeg watchdog itself takes up to 15s to notice + restart).
  const VIDEO_OFFLINE_MS = 10000;

  function stateSnapshot() {
    return {
      label: cfg.label, armed: state.armed, running: state.running, alertCount: state.alertCount,
      lastAlertAt: state.lastAlertAt, recentAlerts: state.recentAlerts,
      detections: latestDetections, zone: vehicleDetector ? vehicleDetector.getZone() : null,
      zonePoints: currentZonePoints,
      ready: vehicleDetector ? vehicleDetector.isReady() : false,
      videoOffline: videoController ? videoController.msSinceLastFrame() > VIDEO_OFFLINE_MS : false,
    };
  }

  function broadcast() {
    const payload = `data: ${JSON.stringify(stateSnapshot())}\n\n`;
    for (const res of sseClients) res.write(payload);
  }

  let audioQueue = Promise.resolve();
  function withAudioLock(fn) {
    const run = audioQueue.then(fn, fn);
    audioQueue = run.catch(() => {});
    return run;
  }

  async function fireSiren() {
    try {
      await cam.manualAlarm(cfg, 'start');
      await sleep(cfg.sirenMs);
      await cam.manualAlarm(cfg, 'stop');
    } catch (e) {
      console.error('[no-parking][siren] error:', e.message);
    }
  }

  async function runWarningLoop(source) {
    state.running = true;
    state.alertCount += 1;
    state.lastAlertAt = Date.now();
    state.recentAlerts.unshift({ ts: state.lastAlertAt, source });
    state.recentAlerts = state.recentAlerts.slice(0, 20);
    console.log(`[no-parking][warn] starting warning loop (${source})`);
    logEvent({ source, phase: 'warning-start' });
    broadcast();

    const loopStart = Date.now();
    let i = 0;
    try {
      await cam.setSpeakerVolume(cfg, cfg.speakerVolume);
      while (Date.now() - loopStart < cfg.maxLoopMsToggle) {
        const file = cfg.warningFilesVehicle[i % cfg.warningFilesVehicle.length];
        i += 1;
        await withAudioLock(async () => {
          await fireSiren();
          await playOnCamera(cfg, file);
        });
        if (source === 'camera' && (!state.armed || !(vehicleDetector && vehicleDetector.isOccupied()))) break;
        if (source === 'manual') break;
      }
    } catch (e) {
      console.error('[no-parking][warn] playback error:', e.message);
      logEvent({ source, phase: 'error', error: e.message });
    }
    state.running = false;
    console.log('[no-parking][warn] warning loop stopped');
    logEvent({ source, phase: 'warning-stop' });
    broadcast();
  }

  function onOccupiedChange(occupied, detection) {
    console.log(`[no-parking][vehicle] occupancy -> ${occupied ? 'occupied' : 'clear'}`, detection ? `(${detection.cls} conf=${detection.conf.toFixed(2)})` : '');
    logEvent({ source: 'camera', phase: occupied ? 'occupied' : 'clear', detection: detection || null });
    if (!state.armed) return;
    if (occupied && !state.running) runWarningLoop('camera');
  }

  async function connectLoop() {
    while (true) {
      try {
        console.log('[no-parking][camera] authenticating...');
        await cam.auth(cfg);
        console.log('[no-parking][camera] authenticated (YOLO-driven, not camera events)');
        return;
      } catch (e) {
        console.error('[no-parking][camera] auth error:', e.message);
        await sleep(3000);
      }
    }
  }

  function start() {
    connectLoop();

    videoController = startMjpegStream(cfg, (frame) => {
      latestFrame = frame;
      const header = `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
      for (const res of mjpegClients) { res.write(header); res.write(frame); res.write('\r\n'); }
    });

    const pythonBin = process.env.PYTHON_BIN || 'python3';
    const scriptPath = path.join(__dirname, '..', 'yolo_server.py');
    const savedZone = loadZoneSettings();
    currentZonePoints = savedZone.zonePoints;
    vehicleDetector = startVehicleDetector(cfg.id, {
      getLatestFrame: () => latestFrame,
      zone: savedZone.zone,
      pythonBin, scriptPath,
      pollMs: cfg.pollMs,
      stableCount: cfg.stableCount,
      iouSameSpotThreshold: cfg.iouSameSpotThreshold,
      zoneOverlapThreshold: cfg.zoneOverlapThreshold,
      vehicleClasses: cfg.vehicleClasses,
      confidenceThreshold: cfg.confidenceThreshold,
      onOccupiedChange,
      onCandidateEnd: (visit) => {
        const startTime = new Date(visit.startedAt).toLocaleTimeString('th-TH');
        const endTime = new Date(visit.endedAt).toLocaleTimeString('th-TH');
        console.log(`[no-parking][yolo] visit ${startTime}-${endTime} (${(visit.durationMs / 1000).toFixed(1)}s) ${visit.cls} maxConf=${visit.maxConf.toFixed(2)} triggered=${visit.triggered}`);
        logEvent({ source: 'camera', phase: 'vehicle-visit', ...visit });
      },
      onSample: ({ detections, best, bestOverlap }) => {
        latestDetections = detections;
        console.log(`[no-parking][yolo] detections=${detections.length} best=${best ? `${best.cls}@${bestOverlap.toFixed(2)}` : 'none'}`);
        broadcast();
      },
    });
  }

  // http.createServer handler for everything under the `/no-parking` prefix.
  // req.url has already had the prefix stripped by the caller.
  function handleRequest(req, res) {
    if (req.url === '/stream.mjpg') {
      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
        'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache', Connection: 'close',
      });
      mjpegClients.add(res);
      req.on('close', () => mjpegClients.delete(res));
      return true;
    }

    if (req.url === '/events') {
      // See channels/intrusion.js's startSse for why: a reverse proxy (e.g.
      // a Cloudflare tunnel) can buffer a chunked response until enough
      // bytes cross the wire, so an SSE stream that only writes on real
      // state changes can sit fully buffered and never render client-side.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
      res.on('close', () => clearInterval(heartbeat));
      res.write(`data: ${JSON.stringify(stateSnapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return true;
    }

    if (req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(stateSnapshot()));
      return true;
    }

    if (req.url === '/toggle-armed' && req.method === 'POST') {
      setArmed(!state.armed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, armed: state.armed }));
      return true;
    }

    if (req.url === '/set-armed' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { armed } = JSON.parse(body);
          if (typeof armed !== 'boolean') throw new Error('armed must be true/false');
          setArmed(armed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, armed: state.armed }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return true;
    }

    if (req.url === '/test-alarm' && req.method === 'POST') {
      if (!state.running) runWarningLoop('manual');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    if (req.url === '/set-zone' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { zone, zonePoints } = JSON.parse(body);
          if (!Array.isArray(zone) || zone.length !== 4) throw new Error('zone must be [x1,y1,x2,y2]');
          vehicleDetector.setZone(zone);
          currentZonePoints = zonePoints || null;
          saveZoneSettings(zone, currentZonePoints);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return true;
    }

    return false;
  }

  // Exposed for mode.js — a mode switch arms/disarms the front camera
  // directly, in-process, same as the /set-armed route but without the
  // logEvent source tag hardcoded to 'manual'.
  function setArmed(armed, source = 'manual') {
    state.armed = armed;
    armedStateStore.setNoParking(armed);
    logEvent({ source, phase: state.armed ? 'armed' : 'disarmed' });
    if (state.armed && vehicleDetector && vehicleDetector.isOccupied() && !state.running) {
      runWarningLoop('camera');
    }
    broadcast();
  }

  return { start, handleRequest, stateSnapshot, setArmed };
}

module.exports = { createNoParkingChannel };

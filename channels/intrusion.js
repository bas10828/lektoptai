const fs = require('fs');
const path = require('path');
const cam = require('../camera-client');
const { playOnCamera } = require('../talk-client');
const { startMjpegStream } = require('../video-stream');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Back-house intrusion channel: N cameras, each with its own camera-event
// subscribe + presence-timeout warning loop + independent armed state (one
// camera lingering must not block another's alert). A single shared MJPEG
// transcoder previews whichever camera the dashboard currently has
// selected, via video-stream.js's switchTo() — avoids running one ffmpeg
// per camera on this CPU-only machine.
function createIntrusionChannel(camConfigs, dataDir, armedStateStore) {
  const eventLogPath = path.join(dataDir, 'intrusion-events.log');
  function logEvent(entry) {
    fs.appendFile(eventLogPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', () => {});
  }

  const cams = new Map(); // id -> { cfg, state, rawEvents }
  for (const cfg of camConfigs) {
    cams.set(cfg.id, {
      cfg,
      state: {
        armed: cfg.armedDefault, running: false, alertCount: 0, lastAlertAt: null, recentAlerts: [], lastSeenAt: 0,
        stopRequested: false, connected: false,
        // Phantom-reannounce filter state (see reference_vigi_openapi_gotchas):
        // this camera family re-emits the last-fired enhance/anomaly event
        // type on an internal ~16s timer regardless of real-world state, so
        // a naive "any event = still present" reset never expires once
        // triggered. Track deltas since the last confirmed-real event and
        // ignore a run whose summed delta lands on a ~16000ms multiple.
        lastRawEventAt: 0,
        phantomRunSum: 0,
      },
      rawEvents: [],
    });
  }
  const PHANTOM_PERIOD_MS = 16000;
  const PHANTOM_TOLERANCE_MS = 700;
  const RAW_LOG_CAP = 100;

  // A reverse proxy sitting in front of this server (e.g. a Cloudflare
  // tunnel) can buffer a chunked response until either enough bytes pile up
  // or a byte actually crosses the wire — an SSE connection that only
  // writes on real events can sit fully buffered for minutes, so the
  // dashboard behind it never renders anything. flushHeaders() forces the
  // headers out immediately instead of waiting for the first write, and a
  // periodic ": ping" comment (SSE's designated no-op line) keeps bytes
  // moving even when nothing has actually changed.
  function startSse(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => clearInterval(heartbeat));
  }

  const sseClients = new Set();
  const mjpegClients = new Set();
  const MJPEG_BOUNDARY = 'intrusionboundary';
  let selectedCamId = camConfigs[0].id;
  let videoController = null;
  const VIDEO_OFFLINE_MS = 10000;

  function allSnapshot() {
    return {
      selectedCamId,
      // Only the currently-previewed camera has a live MJPEG feed at all
      // (see the module comment — one shared transcoder, not one per
      // camera), so video-offline only makes sense for that one.
      videoOffline: videoController ? videoController.msSinceLastFrame() > VIDEO_OFFLINE_MS : false,
      cams: [...cams.values()].map(({ cfg, state }) => ({
        id: cfg.id, label: cfg.label, camIp: cfg.camIp, ...state,
      })),
    };
  }

  function broadcast() {
    const payload = `data: ${JSON.stringify(allSnapshot())}\n\n`;
    for (const res of sseClients) res.write(payload);
  }

  // Shared by the /set-all-armed HTTP route and mode.js (mode switches call
  // this directly — no HTTP round-trip needed since they run in-process).
  function setAllArmed(armed, source = 'manual-all') {
    for (const c of cams.values()) {
      c.state.armed = armed;
      armedStateStore.setIntrusion(c.cfg.id, armed);
      if (!armed && c.state.running) c.state.stopRequested = true;
      logEvent({ camId: c.cfg.id, source, phase: armed ? 'armed' : 'disarmed' });
    }
    broadcast();
  }

  function broadcastRaw(camId, entry) {
    const c = cams.get(camId);
    c.rawEvents.unshift(entry);
    c.rawEvents = c.rawEvents.slice(0, RAW_LOG_CAP);
    if (camId !== selectedCamId) return; // only the selected camera's raw feed streams live
    const payload = `data: ${JSON.stringify({ camId, ...entry })}\n\n`;
    for (const res of rawLogClientsFor(camId)) res.write(payload);
  }

  const rawLogClients = new Set(); // subscribed to whichever camId is currently selected
  function rawLogClientsFor(camId) {
    return camId === selectedCamId ? rawLogClients : new Set();
  }

  async function fireSiren(cfg) {
    try {
      await cam.manualAlarm(cfg, 'start');
      await sleep(cfg.sirenMs);
      await cam.manualAlarm(cfg, 'stop');
    } catch (e) {
      console.error(`[intrusion:${cfg.id}][siren] error:`, e.message);
    }
  }

  async function runWarningLoop(camId, source) {
    const c = cams.get(camId);
    const { cfg, state } = c;
    state.running = true;
    state.alertCount += 1;
    state.lastAlertAt = Date.now();
    state.recentAlerts.unshift({ ts: state.lastAlertAt, source });
    state.recentAlerts = state.recentAlerts.slice(0, 20);
    console.log(`[intrusion:${camId}][warn] starting warning loop (${source})`);
    logEvent({ camId, source, phase: 'warning-start' });
    broadcast();

    const loopStart = Date.now();
    let i = 0;
    try {
      await cam.setSpeakerVolume(cfg, cfg.speakerVolume);
      while (Date.now() - loopStart < cfg.maxLoopMs) {
        const file = cfg.warningFiles[i % cfg.warningFiles.length];
        i += 1;
        await fireSiren(cfg);
        await playOnCamera(cfg, file);
        // Checked after every clip (not just at the top) so a disarm or the
        // manual stop button takes effect within one clip's length instead
        // of waiting for the loop to re-enter.
        if (state.stopRequested) break;
        if (source === 'camera' && !state.armed) break;
        if (Date.now() - state.lastSeenAt > cfg.presenceTimeoutMs) break;
      }
    } catch (e) {
      console.error(`[intrusion:${camId}][warn] playback error:`, e.message);
      logEvent({ camId, source, phase: 'error', error: e.message });
    }
    state.running = false;
    state.stopRequested = false;
    console.log(`[intrusion:${camId}][warn] warning loop stopped`);
    logEvent({ camId, source, phase: 'warning-stop' });
    broadcast();
  }

  // Returns true if this event should be ignored as the camera's internal
  // ~16s phantom re-announce rather than a real, new detection. See
  // reference_vigi_openapi_gotchas — confirmed on this camera family: once
  // a person/motion event fires, the camera keeps re-emitting the same
  // event type roughly every 16000ms regardless of whether anyone is still
  // there, occasionally splitting one tick into two back-to-back messages
  // whose deltas still sum to ~16000ms.
  function isPhantomReannounce(state, now) {
    const delta = state.lastRawEventAt ? now - state.lastRawEventAt : Infinity;
    state.lastRawEventAt = now;
    if (delta > PHANTOM_PERIOD_MS + PHANTOM_TOLERANCE_MS) {
      state.phantomRunSum = 0; // real gap — start a fresh run
      return false;
    }
    state.phantomRunSum += delta;
    const rem = state.phantomRunSum % PHANTOM_PERIOD_MS;
    const onBeat = rem < PHANTOM_TOLERANCE_MS || rem > PHANTOM_PERIOD_MS - PHANTOM_TOLERANCE_MS;
    if (onBeat) state.phantomRunSum = 0; // this tick accounted for, next run starts fresh
    return onBeat;
  }

  function onDetected(camId) {
    const c = cams.get(camId);
    if (isPhantomReannounce(c.state, Date.now())) {
      console.log(`[intrusion:${camId}] person-event (phantom re-announce, ignored)`);
      return;
    }
    console.log(`[intrusion:${camId}] person-event (real, armed=${c.state.armed})`);
    c.state.lastSeenAt = Date.now();
    if (!c.state.armed) return;
    if (!c.state.running) runWarningLoop(camId, 'camera');
  }

  function onCameraEvent(camId, cfg, obj) {
    broadcastRaw(camId, { ts: Date.now(), raw: obj });
    if (!obj || !obj.event_type) return; // heartbeats, not logged — too noisy
    console.log(`[intrusion:${camId}] event: ${obj.event_type}`);
    const matches = (eventType) => obj.event_type === eventType || obj.event_type.startsWith(eventType + '_');
    if (matches(cfg.entryEventType)) onDetected(camId);
  }

  async function connectLoop(cfg) {
    const c = cams.get(cfg.id);
    while (true) {
      try {
        console.log(`[intrusion:${cfg.id}][camera] authenticating (${cfg.camIp})...`);
        const stok = await cam.auth(cfg);
        // Subscribing to an "_enhance" suffixed type alone gets errCode
        // -10010 (parameter error) on this firmware — the base type must be
        // included in the same call alongside it. Confirmed live 2026-09-02.
        const baseType = cfg.entryEventType.split('_')[0];
        const subTypes = [...new Set([baseType, cfg.entryEventType])];
        console.log(`[intrusion:${cfg.id}][camera] authenticated, subscribing to ${subTypes.join(',')} (region/zone is set in-camera, not here)...`);
        c.state.connected = true;
        broadcast();
        await new Promise((resolve) => {
          cam.subscribe(cfg, stok, subTypes, cfg.heartbeatSec, (obj) => onCameraEvent(cfg.id, cfg, obj), (err) => {
            if (err) console.error(`[intrusion:${cfg.id}][camera] subscribe error:`, err.message);
            else console.log(`[intrusion:${cfg.id}][camera] subscribe connection ended`);
            resolve();
          });
        });
      } catch (e) {
        console.error(`[intrusion:${cfg.id}][camera] connect loop error:`, e.message);
      }
      c.state.connected = false;
      broadcast();
      console.log(`[intrusion:${cfg.id}][camera] reconnecting in 3s...`);
      await sleep(3000);
    }
  }

  function start() {
    for (const { cfg } of cams.values()) connectLoop(cfg);

    videoController = startMjpegStream(cams.get(selectedCamId).cfg, (frame) => {
      const header = `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
      for (const res of mjpegClients) { res.write(header); res.write(frame); res.write('\r\n'); }
    });
  }

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

    if (req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(allSnapshot()));
      return true;
    }

    if (req.url === '/events') {
      startSse(res);
      res.write(`data: ${JSON.stringify(allSnapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return true;
    }

    if (req.url === '/raw-events') {
      startSse(res);
      const c = cams.get(selectedCamId);
      for (const entry of [...c.rawEvents].reverse()) res.write(`data: ${JSON.stringify({ camId: selectedCamId, ...entry })}\n\n`);
      rawLogClients.add(res);
      req.on('close', () => rawLogClients.delete(res));
      return true;
    }

    if (req.url === '/select' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { camId } = JSON.parse(body);
          if (!cams.has(camId)) throw new Error('unknown camId');
          selectedCamId = camId;
          videoController.switchTo(cams.get(camId).cfg);
          broadcast();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return true;
    }

    if (req.url === '/set-all-armed' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { armed } = JSON.parse(body);
          if (typeof armed !== 'boolean') throw new Error('armed must be true/false');
          setAllArmed(armed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, armed }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return true;
    }

    if (req.url === '/toggle-armed' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { camId } = JSON.parse(body);
          const c = cams.get(camId);
          if (!c) throw new Error('unknown camId');
          c.state.armed = !c.state.armed;
          armedStateStore.setIntrusion(camId, c.state.armed);
          if (!c.state.armed && c.state.running) c.state.stopRequested = true;
          logEvent({ camId, source: 'manual', phase: c.state.armed ? 'armed' : 'disarmed' });
          broadcast();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, armed: c.state.armed }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return true;
    }

    if (req.url === '/stop-alarm' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { camId } = JSON.parse(body);
          const c = cams.get(camId);
          if (!c) throw new Error('unknown camId');
          c.state.stopRequested = true;
          // Silence the siren/strobe immediately instead of waiting for the
          // current clip to finish — manualAlarm('stop') is safe to call
          // even if no siren is actually mid-burst right now.
          cam.manualAlarm(c.cfg, 'stop').catch(() => {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return true;
    }

    if (req.url === '/test-alarm' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { camId } = JSON.parse(body);
          const c = cams.get(camId);
          if (!c) throw new Error('unknown camId');
          if (!c.state.running) {
            c.state.lastSeenAt = Date.now();
            runWarningLoop(camId, 'manual');
          }
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

  return { start, handleRequest, allSnapshot, setAllArmed };
}

module.exports = { createIntrusionChannel };

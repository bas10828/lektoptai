const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function iou(a, b) {
  const [ax1, ay1, ax2, ay2] = a;
  const [bx1, by1, bx2, by2] = b;
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = (ax2 - ax1) * (ay2 - ay1);
  const areaB = (bx2 - bx1) * (by2 - by1);
  return inter / (areaA + areaB - inter);
}

// Fraction of box `a`'s own area that overlaps rectangle `zone` — not IoU,
// since a big zone containing a small car should still count as "fully in
// the zone" even though IoU would be tiny.
function fractionInZone(box, zone) {
  const [bx1, by1, bx2, by2] = box;
  const [zx1, zy1, zx2, zy2] = zone;
  const ix1 = Math.max(bx1, zx1), iy1 = Math.max(by1, zy1);
  const ix2 = Math.min(bx2, zx2), iy2 = Math.min(by2, zy2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const boxArea = (bx2 - bx1) * (by2 - by1);
  if (boxArea <= 0) return 0;
  return inter / boxArea;
}

// Spawns the long-lived Python YOLO worker once (model load is slow —
// reloading per-poll would waste the whole poll interval) and talks to it
// over stdin/stdout, one image path per line in, one JSON result per line
// out. Same subprocess-pipe pattern this project already uses for ffmpeg.
function startYoloWorker(pythonBin, scriptPath, onReady, vehicleClasses, confidenceThreshold) {
  const proc = spawn(pythonBin, [scriptPath], {
    cwd: path.dirname(scriptPath),
    env: {
      ...process.env,
      VEHICLE_CLASSES: (vehicleClasses || ['car', 'truck', 'bus']).join(','),
      CONFIDENCE_THRESHOLD: String(confidenceThreshold || 0.4),
    },
  });
  let buf = '';
  const pending = [];

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const resolve = pending.shift();
      if (resolve) {
        try { resolve(JSON.parse(line)); } catch (e) { resolve({ error: 'bad JSON from worker: ' + line }); }
      }
    }
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.includes('READY')) { if (onReady) onReady(); return; }
    console.error('[yolo-worker]', s.trim());
  });
  proc.on('exit', (code) => console.error(`[yolo-worker] exited (code=${code})`));

  function infer(imagePath) {
    return new Promise((resolve) => {
      pending.push(resolve);
      proc.stdin.write(imagePath + '\n');
    });
  }

  return { infer, kill: () => proc.kill() };
}

// zone: [x1,y1,x2,y2] in the SAME pixel space as the frames handed to
// getLatestFrame() (960-wide scaled MJPEG frames, see video-stream.js).
function startVehicleDetector(id, { getLatestFrame, zone, pythonBin, scriptPath, pollMs = 5000, stableCount = 3, iouSameSpotThreshold = 0.5, zoneOverlapThreshold = 0.3, vehicleClasses, confidenceThreshold, onOccupiedChange, onSample, onCandidateEnd }) {
  const tmpDir = os.tmpdir();
  const framePath = path.join(tmpDir, `yolo-frame-${id}.jpg`);
  let currentZone = zone;
  let occupied = false;
  let lastBox = null; // the car bbox we're currently tracking as "possibly parked"
  let sameSpotCount = 0;
  let missingCount = 0;
  let ready = false;
  let busy = false;
  // Per-visit tracking so every vehicle that enters the zone gets a
  // start/end timestamp + duration logged, whether or not it stayed long
  // enough to trigger — added 2026-08-28 so the boss can cross-check
  // against the camera's own recording ("did that one actually pass
  // through, or should it have triggered?") and tune pollMs/stableCount
  // from real timing instead of guessing.
  let candidateStartedAt = null;
  let candidateTriggered = false;
  let candidateCls = null;
  let candidateMaxConf = 0;

  const worker = startYoloWorker(pythonBin, scriptPath, () => { ready = true; console.log('[yolo] worker ready'); }, vehicleClasses, confidenceThreshold);

  async function pollOnce() {
    if (busy || !ready) return;
    const frame = getLatestFrame();
    if (!frame) return;
    busy = true;
    try {
      fs.writeFileSync(framePath, frame);
      const result = await worker.infer(framePath);
      if (result.error) { console.error('[yolo] infer error:', result.error); return; }

      // Candidate = a vehicle-class box that's substantially inside the
      // drawn zone. If several qualify, track the one with the highest
      // zone overlap.
      let best = null, bestOverlap = 0;
      for (const det of result.detections) {
        const overlap = fractionInZone(det.box, currentZone);
        if (overlap >= zoneOverlapThreshold && overlap > bestOverlap) { best = det; bestOverlap = overlap; }
      }

      if (onSample) onSample({ detections: result.detections, best, bestOverlap });

      if (best) {
        missingCount = 0;
        // Position (IoU) only, NOT class — YOLO flickers class between
        // consecutive polls for the same parked vehicle (car/truck/bus
        // confusion from this camera's angle, esp. pickups/SUVs) far more
        // often than a different vehicle swaps into the exact same tight
        // zone with zero empty-frame gap between polls. Requiring class
        // match (93dd11d) fixed the latter but broke the alarm entirely
        // for any vehicle whose class flickers, since sameSpotCount kept
        // resetting and stableCount was never reached — confirmed live
        // 2026-09-01 (car parked, never triggered, log showed cls
        // alternating car/truck). IoU>=0.5 between 3s-apart polls is
        // already a strong same-vehicle signal on its own.
        const samePos = lastBox && iou(best.box, lastBox) >= iouSameSpotThreshold;
        if (samePos) {
          sameSpotCount += 1;
        } else {
          // Position jumped -> a different visit. Close out whatever was
          // being tracked before starting the new one.
          if (candidateStartedAt && onCandidateEnd) {
            onCandidateEnd({ startedAt: candidateStartedAt, endedAt: Date.now(), durationMs: Date.now() - candidateStartedAt, triggered: candidateTriggered, cls: candidateCls, maxConf: candidateMaxConf });
          }
          candidateStartedAt = Date.now();
          candidateTriggered = false;
          candidateCls = best.cls;
          candidateMaxConf = 0;
          sameSpotCount = 1; // new/moved car — restart the "is it staying put" count
        }
        candidateMaxConf = Math.max(candidateMaxConf, best.conf);
        lastBox = best.box;
        if (!occupied && sameSpotCount >= stableCount) {
          occupied = true;
          candidateTriggered = true;
          onOccupiedChange(true, best);
        }
      } else {
        sameSpotCount = 0;
        missingCount += 1;
        if (candidateStartedAt && missingCount >= stableCount) {
          if (onCandidateEnd) {
            onCandidateEnd({ startedAt: candidateStartedAt, endedAt: Date.now(), durationMs: Date.now() - candidateStartedAt, triggered: candidateTriggered, cls: candidateCls, maxConf: candidateMaxConf });
          }
          candidateStartedAt = null;
        }
        if (occupied && missingCount >= stableCount) {
          occupied = false;
          lastBox = null;
          onOccupiedChange(false, null);
        }
      }
    } catch (e) {
      console.error('[yolo] poll error:', e.message);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(pollOnce, pollMs);

  return {
    isOccupied: () => occupied,
    isReady: () => ready,
    getZone: () => currentZone,
    setZone: (z) => { currentZone = z; },
    stop: () => { clearInterval(timer); worker.kill(); },
  };
}

module.exports = { startVehicleDetector, iou, fractionInZone };

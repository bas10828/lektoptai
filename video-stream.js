const { spawn } = require('child_process');

// Resolve ffmpeg: prefer PATH, fall back to the known winget install location
// (winget adds it to PATH but the current process was started before that PATH change).
const FFMPEG_CANDIDATES = [
  'C:\\Users\\This PC\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe',
  'ffmpeg',
];

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

// Runs a single ffmpeg process at a time, converting one camera's RTSP feed
// to a stream of JPEG frames. switchTo() kills the current process and
// respawns against a different camera's RTSP URL instead of running one
// ffmpeg per camera (cheaper on CPU/bandwidth for a "pick one to watch" UI).
function startMjpegStream(initialCfg, onFrame) {
  let currentCfg = initialCfg;
  let currentProc = null;
  let attempt = 0;
  let intentional = false;
  let lastFrameAt = 0; // outer scope (not per-spawn) so callers can tell "offline" across a restart cycle

  function spawnFfmpeg() {
    const camCfg = currentCfg;
    const rtspUrl = `rtsp://${camCfg.camUser}:${encodeURIComponent(camCfg.camPass)}@${camCfg.camIp}:${camCfg.rtspPort}/${camCfg.rtspPath}`;
    const bin = FFMPEG_CANDIDATES[attempt % FFMPEG_CANDIDATES.length];
    console.log(`[video] starting ffmpeg (${bin}) -> ${camCfg.id} (${camCfg.camIp}/${camCfg.rtspPath}) ...`);

    const proc = spawn(bin, [
      '-rtsp_transport', 'tcp',
      '-timeout', '5000000', // microseconds; abort instead of hanging forever if the camera is unreachable
      '-i', rtspUrl,
      '-an',
      '-f', 'mjpeg',
      '-q:v', '5',
      '-r', '10',
      '-vf', 'scale=960:-2',
      'pipe:1',
    ]);
    currentProc = proc;

    let buf = Buffer.alloc(0);
    let lastDataAt = Date.now();

    // Watchdog: if ffmpeg produces no frame data for a while (e.g. it hangs
    // silently instead of exiting when the network drops), kill it so the
    // exit handler below can restart it.
    const watchdog = setInterval(() => {
      if (Date.now() - lastDataAt > 15000) {
        console.error('[video] no frames for 15s, killing stalled ffmpeg process');
        clearInterval(watchdog);
        proc.kill('SIGKILL');
      }
    }, 5000);

    proc.stdout.on('data', (chunk) => {
      lastDataAt = Date.now();
      lastFrameAt = lastDataAt;
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const start = buf.indexOf(SOI);
        if (start === -1) { buf = Buffer.alloc(0); break; }
        const end = buf.indexOf(EOI, start + 2);
        if (end === -1) {
          if (start > 0) buf = buf.slice(start);
          break;
        }
        const frame = buf.slice(start, end + 2);
        buf = buf.slice(end + 2);
        onFrame(frame);
      }
    });

    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    let restarted = false;
    function restart() {
      clearInterval(watchdog);
      if (restarted) return;
      restarted = true;
      const delay = intentional ? 0 : 3000;
      intentional = false;
      attempt += 1;
      setTimeout(spawnFfmpeg, delay);
    }

    proc.on('exit', (code, signal) => {
      console.error(`[video] ffmpeg exited (code=${code} signal=${signal}), restarting...`);
      if (stderrTail) console.error('[video] ffmpeg last output:\n' + stderrTail);
      restart();
    });

    proc.on('error', (err) => {
      console.error('[video] ffmpeg spawn error:', err.message);
      restart();
    });
  }

  spawnFfmpeg();

  return {
    switchTo(newCfg) {
      if (newCfg.id === currentCfg.id) return;
      console.log(`[video] switching camera -> ${newCfg.id}`);
      currentCfg = newCfg;
      intentional = true;
      attempt = 0;
      if (currentProc) currentProc.kill('SIGKILL');
      else spawnFfmpeg();
    },
    currentId() {
      return currentCfg.id;
    },
    // Frames not landing recently means the viewer's <img> is showing a
    // frozen stale picture with no visual cue that anything's wrong (MJPEG
    // in an <img> tag never re-fires load/error on a silent stall) — expose
    // this so a channel can surface an explicit "camera offline" state
    // instead of leaving it silently frozen.
    msSinceLastFrame() {
      return lastFrameAt ? Date.now() - lastFrameAt : Infinity;
    },
  };
}

module.exports = { startMjpegStream };

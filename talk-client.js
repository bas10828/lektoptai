const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function parseResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep === -1) return null;
  const headerPart = buf.slice(0, sep).toString();
  const lines = headerPart.split('\r\n');
  const statusMatch = lines[0].match(/RTSP\/1\.0 (\d+)/);
  if (!statusMatch) return null;
  const status = parseInt(statusMatch[1], 10);
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
  }
  const contentLength = parseInt(headers['content-length'] || '0', 10);
  const bodyStart = sep + 4;
  if (buf.length < bodyStart + contentLength) return null;
  const body = buf.slice(bodyStart, bodyStart + contentLength).toString();
  return { status, headers, body, consumed: bodyStart + contentLength };
}

function parseDigestHeader(wwwAuth) {
  const out = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(wwwAuth))) out[m[1]] = m[2];
  return out;
}

// Plays a G711 mu-law raw audio file through a camera's speaker via the
// OpenAPI "talk" stream interface (RTSP-style MULTITRANS + SHA-256 digest
// auth + RTP-over-TCP framed audio). Resolves when playback is done, or
// rejects on error/timeout.
function playOnCamera(camCfg, ulawFilePath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const uri = `rtsp://${camCfg.camIp}/multitrans`;
    let cseq = 1;
    let buffer = Buffer.alloc(0);
    let stage = 'unauthed';
    let finished = false;

    const socket = net.connect(camCfg.rtspPort, camCfg.camIp);

    // Briefly raise this process's OS scheduling priority for the audio
    // frame-pacing window — this Node process shares the machine with heavy
    // ML workloads (body-tracker etc.) that can starve the event loop just
    // long enough to cause audible RTP frame jitter. Best-effort: some
    // platforms/permission setups reject setPriority, so never let it break
    // playback.
    try { os.setPriority(0, os.constants.priority.PRIORITY_HIGH); } catch (e) { /* ignore */ }
    function restorePriority() {
      try { os.setPriority(0, os.constants.priority.PRIORITY_NORMAL); } catch (e) { /* ignore */ }
    }

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      restorePriority();
      socket.destroy();
      reject(new Error('talk mode timed out'));
    }, timeoutMs);

    function finish(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      restorePriority();
      if (err) reject(err);
      else resolve();
    }

    function sendMultitrans(extraHeaders) {
      const body = JSON.stringify({
        type: 'request',
        seq: String(cseq),
        params: { method: 'get', talk: { mode: 'half_duplex' } },
      });
      let req = `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: ${cseq}\r\n`;
      for (const [k, v] of Object.entries(extraHeaders)) req += `${k}: ${v}\r\n`;
      req += `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      socket.write(req);
    }

    socket.on('connect', () => {
      socket.setNoDelay(true); // disable Nagle's algorithm — don't buffer small RTP frames
      sendMultitrans({});
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseResponse(buffer);
      if (!parsed) return;
      buffer = buffer.slice(parsed.consumed);

      if (stage === 'unauthed' && parsed.status === 401) {
        const digest = parseDigestHeader(parsed.headers['www-authenticate'] || '');
        const cnonce = crypto.randomBytes(8).toString('hex');
        const nc = '00000001';
        const ha1 = sha256hex(`${camCfg.camUser}:${digest.realm}:${camCfg.camPass}`);
        const ha2 = sha256hex(`MULTITRANS:${uri}`);
        const response = sha256hex(`${ha1}:${digest.nonce}:${nc}:${cnonce}:${digest.qop}:${ha2}`);
        const authHeader = `Digest username="${camCfg.camUser}", realm="${digest.realm}", nonce="${digest.nonce}", uri="${uri}", qop="${digest.qop}", cnonce="${cnonce}", nc="${nc}", response="${response}"`;
        stage = 'authing';
        sendMultitrans({ Authorization: authHeader });
        return;
      }

      if (parsed.status === 200) {
        let json;
        try { json = JSON.parse(parsed.body); } catch (e) { finish(e); return; }
        const params = json.params || json;
        if (params.error_code === 0) {
          stage = 'talking';
          streamAudio();
        } else {
          finish(new Error(`talk errCode=${params.error_code}`));
        }
        return;
      }

      finish(new Error(`unexpected RTSP status ${parsed.status} at stage ${stage}`));
    });

    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish(finished ? null : new Error('connection closed unexpectedly')));

    function streamAudio() {
      const data = fs.readFileSync(ulawFilePath);
      // 20ms/160-byte frames (the standard G.711 RTP ptime) instead of
      // 10ms/80-byte — half as many setTimeout schedulings per second, which
      // gives the far end's jitter buffer more slack against this process's
      // other event-loop work (MJPEG frame relay, subscribeMsg) and reduces
      // audible dropouts confirmed live on the welcome-greeting playback.
      const FRAME_SIZE = 160;
      const FRAME_MS = 20;
      const ssrc = crypto.randomBytes(4);
      let seq = Math.floor(Math.random() * 60000);
      let ts = 0;
      let offset = 0;
      let frameCount = 0;
      const startTime = Date.now();

      // Plain `setTimeout(fn, 10)` chained per frame drifts under event-loop
      // load (GC pauses, other timers) and the far end's jitter buffer starts
      // starving, which is heard as dropouts. Schedule against an absolute
      // target time instead of a relative delay so drift doesn't accumulate.
      function scheduleNext() {
        frameCount += 1;
        const target = startTime + frameCount * FRAME_MS;
        const delay = Math.max(0, target - Date.now());
        setTimeout(sendNextFrame, delay);
      }

      function sendNextFrame() {
        if (finished) return;
        if (offset >= data.length) {
          setTimeout(() => { socket.end(); finish(null); }, 500);
          return;
        }
        const frame = data.slice(offset, offset + FRAME_SIZE);
        offset += FRAME_SIZE;

        const rtpHeader = Buffer.alloc(12);
        rtpHeader[0] = 0x80;
        rtpHeader[1] = 8; // PT=8 (PCMA / G711 A-law)
        rtpHeader.writeUInt16BE(seq & 0xffff, 2);
        rtpHeader.writeUInt32BE(ts >>> 0, 4);
        ssrc.copy(rtpHeader, 8);

        const rtpPacket = Buffer.concat([rtpHeader, frame]);
        const frameHeader = Buffer.alloc(4);
        frameHeader[0] = 0x24;
        frameHeader[1] = 0;
        frameHeader.writeUInt16BE(rtpPacket.length, 2);

        socket.write(Buffer.concat([frameHeader, rtpPacket]));
        seq += 1;
        ts += FRAME_SIZE;
        scheduleNext();
      }

      sendNextFrame();
    }
  });
}

module.exports = { playOnCamera };

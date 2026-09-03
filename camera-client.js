const https = require('https');
const crypto = require('crypto');

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function requestJson(cfg, path, body) {
  const data = JSON.stringify(body);
  const options = {
    hostname: cfg.camIp,
    port: cfg.camPort,
    path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
    rejectUnauthorized: false,
    agent: false, // camera closes the socket after each response; never reuse it
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error(`Bad JSON from camera: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function auth(cfg) {
  const step1 = await requestJson(cfg, '/', { method: 'doAuth', params: null });
  if (!step1.authenticate) {
    throw new Error(`doAuth step1 unexpected response: ${JSON.stringify(step1)}`);
  }
  const { realm, nonce, method, uri } = step1.authenticate;
  const a1 = sha256hex(`${cfg.camUser}:${realm}:${cfg.camPass}`);
  const a2 = sha256hex(`${method}:${uri}`);
  const response = sha256hex(`${a1}:${nonce}:${a2}`);
  const step2 = await requestJson(cfg, '/', { method: 'doAuth', params: { nonce, response } });
  if (step2.errCode !== 0 || !step2.stok) {
    throw new Error(`doAuth step2 failed: ${JSON.stringify(step2)}`);
  }
  return step2.stok;
}

function call(cfg, stok, method, params) {
  const body = params ? { method, params } : { method };
  return requestJson(cfg, `/stok=${stok}`, body);
}

// Opens a persistent subscribeMsg connection. Calls onEvent(obj) for every
// parsed JSON part (heartbeats included). Calls onEnd(err) once when the
// connection closes or errors, so the caller can reconnect.
function subscribe(cfg, stok, eventTypes, heartbeatSec, onEvent, onEnd) {
  const body = JSON.stringify({
    method: 'subscribeMsg',
    params: { event_type: eventTypes, heartbeat: heartbeatSec },
  });
  const options = {
    hostname: cfg.camIp,
    port: cfg.camPort,
    path: `/stok=${stok}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    rejectUnauthorized: false,
    agent: false,
  };

  const req = https.request(options, (res) => {
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split('----boundary--');
      buffer = parts.pop(); // keep the last (possibly incomplete) part
      for (const part of parts) {
        const sepIdx = part.indexOf('\r\n\r\n');
        if (sepIdx === -1) continue;
        const jsonStr = part.slice(sepIdx + 4).trim();
        if (!jsonStr) continue;
        try {
          onEvent(JSON.parse(jsonStr));
        } catch (e) {
          // ignore malformed fragment, wait for more data
        }
      }
    });
    res.on('end', () => onEnd(null));
    res.on('error', (err) => onEnd(err));
  });
  req.on('error', (err) => onEnd(err));
  req.write(body);
  req.end();
  return req;
}

async function callAuthed(cfg, method, params) {
  const stok = await auth(cfg);
  return call(cfg, stok, method, params);
}

function setSpeakerVolume(cfg, volume) {
  return callAuthed(cfg, 'setSpeakerVolume', { volume });
}

function manualAlarm(cfg, act) {
  return callAuthed(cfg, 'manualAlarm', { act });
}

module.exports = { auth, call, subscribe, sha256hex, callAuthed, setSpeakerVolume, manualAlarm };

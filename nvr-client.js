const https = require('https');
const crypto = require('crypto');

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// The NVR OpenAPI is a completely separate scheme from the IPC camera
// OpenAPI (camera-client.js) — GET-based RFC2617-style digest auth (no
// qop/cnonce) against /openapi/token, returning a percent-encoded JWT
// access_token. See reference_vigi_openapi_gotchas.
const REQUEST_TIMEOUT_MS = 4000;

// A dead/unreachable NVR (wrong IP, network hiccup) would otherwise hang on
// the OS-level TCP timeout (20s+ on Windows) — fail fast instead so this
// never delays camera channels from starting (see server.js: the NVR name
// lookup runs in the background, but a slow failure here would still make
// error logs and any future consumer of getChannelNamesByIp wait needlessly).
function request(cfg, method, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: cfg.nvrIp, port: cfg.nvrPort, path, method,
      rejectUnauthorized: false, headers: headers || {}, timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`NVR request timed out after ${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.end();
  });
}

function parseDigest(wwwAuth) {
  const out = {};
  const re = /(\w+)="([^"]+)"/g;
  let m;
  while ((m = re.exec(wwwAuth))) out[m[1]] = m[2];
  return out;
}

async function getToken(cfg) {
  const path = '/openapi/token';
  const step1 = await request(cfg, 'GET', path);
  const { realm, nonce } = parseDigest(step1.headers['www-authenticate'] || '');
  const ha1 = sha256hex(`${cfg.nvrUser}:${realm}:${cfg.nvrPass}`);
  const ha2 = sha256hex(`GET:${path}`);
  const response = sha256hex(`${ha1}:${nonce}:${ha2}`);
  const authHeader = `Digest username="${cfg.nvrUser}", nonce="${nonce}", realm="${realm}", response="${response}"`;
  const step2 = await request(cfg, 'GET', path, { Authorization: authHeader });
  const parsed = JSON.parse(step2.body);
  if (!parsed.access_token) throw new Error(`NVR token failed: ${step2.body}`);
  return decodeURIComponent(parsed.access_token);
}

// Returns a Map of camIp -> decoded channel name (e.g. "C06-หลังบ้าน"), or
// an empty Map if the NVR is unreachable/misconfigured — callers should
// fall back to their own placeholder labels rather than fail startup.
async function getChannelNamesByIp(cfg) {
  const byIp = new Map();
  try {
    const token = await getToken(cfg);
    const res = await request(cfg, 'GET', '/openapi/added_devices', { Authorization: `Bearer ${token}` });
    const parsed = JSON.parse(res.body);
    for (const d of parsed.devices || []) {
      if (d.ip && d.name) byIp.set(d.ip, decodeURIComponent(d.name));
    }
  } catch (e) {
    console.error('[nvr] could not fetch channel names, keeping placeholder labels:', e.message);
  }
  return byIp;
}

module.exports = { getChannelNamesByIp };

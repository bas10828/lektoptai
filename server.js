const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cfg = require('./config');
const { createNoParkingChannel } = require('./channels/no-parking');
const { createIntrusionChannel } = require('./channels/intrusion');
const { createModeController } = require('./mode');
const { createArmedStateStore } = require('./armed-state');
const { getChannelNamesByIp } = require('./nvr-client');
const auth = require('./auth');

const publicDir = path.join(__dirname, 'public');

// Survives a power loss / restart: each camera's last-known armed state
// (relevant to "custom" mode — away/home re-derive their own armed state on
// boot regardless, see mode.js) overrides config.js's cautious armedDefault.
const armedStateStore = createArmedStateStore(__dirname);
cfg.noParking.armedDefault = armedStateStore.getNoParking(cfg.noParking.armedDefault);
for (const camCfg of cfg.intrusionCams) camCfg.armedDefault = armedStateStore.getIntrusion(camCfg.id, camCfg.armedDefault);

const noParking = createNoParkingChannel(cfg.noParking, __dirname, armedStateStore);
const intrusion = createIntrusionChannel(cfg.intrusionCams, __dirname, armedStateStore);
const mode = createModeController({ intrusion, noParking, dataDir: __dirname });

function serveStatic(dir, req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(dir, filePath);
  if (!filePath.startsWith(dir)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html'
      : ext === '.js' ? 'application/javascript'
      : ext === '.css' ? 'text/css'
      : 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

async function handleLogin(req, res) {
  if (req.method === 'GET') return serveStatic(publicDir, { ...req, url: '/login.html' }, res);
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  const ip = auth.clientIp(req);
  const lockout = auth.checkLockout(ip);
  await auth.delay(auth.LOGIN_DELAY_MS);
  if (lockout.locked) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `พยายามผิดหลายครั้งเกินไป ลองใหม่ใน ${lockout.retryAfterSec} วินาที` }));
    return;
  }

  let username = '', password = '';
  try { ({ username = '', password = '' } = JSON.parse(await readBody(req))); } catch (e) { /* fall through to reject below */ }

  if (username === cfg.portalUsername && password === cfg.portalPassword) {
    auth.recordSuccess(ip);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': auth.createSessionCookie() });
    res.end(JSON.stringify({ ok: true }));
  } else {
    auth.recordFailure(ip);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }));
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/login') return handleLogin(req, res);

  if (req.url === '/logout' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': auth.clearSessionCookie() });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === '/shared.css') return serveStatic(publicDir, req, res);

  if (!auth.isValidSession(req)) {
    const wantsHtml = (req.headers.accept || '').includes('text/html');
    if (wantsHtml) {
      res.writeHead(302, { Location: '/login' });
      res.end();
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthenticated' }));
    }
    return;
  }

  if (req.url === '/') {
    res.writeHead(302, { Location: '/no-parking' });
    res.end();
    return;
  }

  if (req.url === '/mode/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mode.status()));
    return;
  }

  if (req.url === '/mode/set' && req.method === 'POST') {
    try {
      const { mode: next } = JSON.parse(await readBody(req));
      mode.setMode(next);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...mode.status() }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/no-parking')) {
    req.url = req.url.slice('/no-parking'.length) || '/';
    if (!noParking.handleRequest(req, res)) serveStatic(path.join(publicDir, 'no-parking'), req, res);
    return;
  }

  if (req.url.startsWith('/intrusion')) {
    req.url = req.url.slice('/intrusion'.length) || '/';
    if (!intrusion.handleRequest(req, res)) serveStatic(path.join(publicDir, 'intrusion'), req, res);
    return;
  }

  return serveStatic(publicDir, req, res);
});

function localLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
  }
  return ips;
}

server.listen(cfg.webPort, '0.0.0.0', () => {
  console.log('VIGI control dashboard running:');
  console.log(`  http://localhost:${cfg.webPort}`);
  for (const ip of localLanIps()) console.log(`  http://${ip}:${cfg.webPort}  <-- ใช้ URL นี้จากเครื่องอื่นในวง LAN`);

  // Cameras must come up immediately regardless of the NVR — never let a
  // slow/unreachable NVR delay real camera connections. Names apply
  // whenever the lookup finishes (or not at all if it fails).
  noParking.start();
  intrusion.start();

  if (cfg.nvr) {
    getChannelNamesByIp(cfg.nvr).then((names) => {
      if (names.has(cfg.noParking.camIp)) cfg.noParking.label = names.get(cfg.noParking.camIp);
      for (const camCfg of cfg.intrusionCams) {
        if (names.has(camCfg.camIp)) camCfg.label = names.get(camCfg.camIp);
      }
      console.log(`[nvr] pulled ${names.size} channel name(s) from ${cfg.nvr.nvrIp}`);
    });
  }
});

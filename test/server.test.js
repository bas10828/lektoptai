// End-to-end HTTP contract of server.js, as used by the external LINE
// watcher on the server (it logs in, reads /intrusion/state.selectedCamId,
// switches cameras with POST /intrusion/select and grabs a frame from the
// stream). Runs a real server.js in a child process with hardware stubbed
// (fixtures/stub-hardware.js), a throwaway env and a temp data dir — it never
// sees production's .env, state files or cameras. If a CONTRACT test fails,
// tell the server side before changing the expectation.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { APP, tmpDir } = require('./helpers');

const PORT = 20000 + Math.floor(Math.random() * 20000);
const USER = 'tester';
const PASS = 'test-pass';
let child;

function req(method, urlPath, { body, cookie, accept = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, headers: { Accept: accept, ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

async function login() {
  const r = await req('POST', '/login', { body: { username: USER, password: PASS } });
  const setCookie = (r.headers['set-cookie'] || [])[0] || '';
  return { r, setCookie, cookie: setCookie.split(';')[0] };
}

test.before(async () => {
  // Explicit env only — never inherit the container's real .env values
  // (NVR_IP, camera IPs, portal passwords).
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    CAM_USER: 'u', CAM_PASS: 'p',
    NOPARKING_CAM_IP: '192.0.2.9', INTRUSION_CAM_IPS: '192.0.2.1,192.0.2.2',
    PORTAL_USERNAME: USER, PORTAL_PASSWORD: PASS,
    SESSION_SECRET: 'test-secret', WEB_PORT: String(PORT),
    VIGI_DATA_DIR: tmpDir('vigi-server-test-'),
  };
  child = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'stub-hardware.js'), 'server.js'], { cwd: APP, env });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + out)), 15000);
    const onData = (d) => {
      out += d;
      if (out.includes('VIGI control dashboard running')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
});

test.after(() => { if (child) child.kill(); });

test('CONTRACT: POST /login with JSON {username,password} sets the vigi_session cookie', async () => {
  const { r, setCookie } = await login();
  assert.equal(r.status, 200);
  assert.match(setCookie, /^vigi_session=[^;]+;/);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
});

test('POST /login with a wrong password is rejected without a cookie', async () => {
  const r = await req('POST', '/login', { body: { username: USER, password: 'nope' } });
  assert.equal(r.status, 401);
  assert.equal(r.headers['set-cookie'], undefined);
});

test('CONTRACT: /intrusion/state needs a session and returns selectedCamId', async () => {
  assert.equal((await req('GET', '/intrusion/state')).status, 401);
  const { cookie } = await login();
  const r = await req('GET', '/intrusion/state', { cookie });
  assert.equal(r.status, 200);
  const state = JSON.parse(r.body);
  assert.equal(state.selectedCamId, 'intr1');
  assert.deepEqual(state.cams.map((c) => c.id), ['intr1', 'intr2']);
});

test('CONTRACT: POST /intrusion/select switches selectedCamId', async () => {
  const { cookie } = await login();
  const r = await req('POST', '/intrusion/select', { cookie, body: { camId: 'intr2' } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
  const state = JSON.parse((await req('GET', '/intrusion/state', { cookie })).body);
  assert.equal(state.selectedCamId, 'intr2');
  assert.equal((await req('POST', '/intrusion/select', { cookie, body: { camId: 'nope' } })).status, 400);
  await req('POST', '/intrusion/select', { cookie, body: { camId: 'intr1' } });
});

test('cache: pages are no-cache and reference shared assets by content hash', async () => {
  const { cookie } = await login();
  const page = await req('GET', '/intrusion', { cookie, accept: 'text/html' });
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-cache');
  const css = page.body.match(/"\/shared\.css\?v=([0-9a-f]{10})"/);
  const js = page.body.match(/"\/shared\.js\?v=([0-9a-f]{10})"/);
  assert.ok(css && js, 'shared.css/shared.js not versioned in the page');

  const loginPage = await req('GET', '/login', { accept: 'text/html' });
  assert.match(loginPage.body, /"\/shared\.css\?v=[0-9a-f]{10}"/);

  // Versioned stylesheet: reachable before login (login page needs it), long-lived.
  const versioned = await req('GET', `/shared.css?v=${css[1]}`, { accept: 'text/css' });
  assert.equal(versioned.status, 200);
  assert.match(versioned.headers['cache-control'], /immutable/);
  // Unversioned URL must revalidate so a proxy can't pin an old copy.
  const plain = await req('GET', '/shared.css', { accept: 'text/css' });
  assert.equal(plain.headers['cache-control'], 'no-cache');
});

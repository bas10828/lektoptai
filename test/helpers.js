// Shared test helpers. Tests never touch real cameras, the NVR or LINE:
// hardware-facing modules are replaced in require.cache before the code
// under test loads them. Each *.test.js runs in its own process under
// `node --test`, so stubs don't leak between files.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const APP = path.join(__dirname, '..');

function stubModule(relPath, exportsObj) {
  const file = require.resolve(path.join(APP, relPath));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}

function tmpDir(prefix = 'vigi-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Event-log lines as parsed JSON. logEvent() appends asynchronously, so wait
// until the file stops growing before reading.
async function readLog(file) {
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size === prev) break;
    prev = size;
    await sleep(20);
  }
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Drives a channel's handleRequest(req, res) the way server.js does
// (prefix already stripped) and resolves with { code, body }.
function request(channel, method, url, body) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.url = url;
    req.method = method;
    const res = {
      writeHead(code) { this.code = code; },
      end(b) { resolve({ code: this.code, body: b ? JSON.parse(b) : null }); },
    };
    channel.handleRequest(req, res);
    if (method === 'POST') {
      req.emit('data', JSON.stringify(body || {}));
      req.emit('end');
    }
  });
}

module.exports = { APP, stubModule, tmpDir, sleep, readLog, request };

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Auto-generated once and persisted locally so nobody has to manage a
// signing secret by hand — an explicit SESSION_SECRET env var still wins if
// set (e.g. to share a secret across multiple server instances).
const SECRET_PATH = path.join(__dirname, '.session-secret');
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  } catch (e) {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_PATH, secret);
    return secret;
  }
}
const SECRET = loadSecret();

const COOKIE_NAME = 'vigi_session';
// "Remember me" is always-on per the ask — no checkbox, just a long expiry.
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function sign(expiry) {
  return crypto.createHmac('sha256', SECRET).update(String(expiry)).digest('hex');
}

function createSessionCookie() {
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const value = `${expiry}.${sign(expiry)}`;
  const maxAgeSec = Math.floor(SESSION_MAX_AGE_MS / 1000);
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isValidSession(req) {
  const value = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!value) return false;
  const [expiryStr, sig] = value.split('.');
  const expiry = Number(expiryStr);
  if (!expiry || !sig || Date.now() > expiry) return false;
  const expected = sign(expiry);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Brute-force protection — in-memory, per-IP, resets on process restart.
// Intentionally simple (this gates a shared customer passcode, not a bank):
// after MAX_FAILS wrong attempts inside FAIL_WINDOW_MS, lock that IP out for
// LOCKOUT_MS and reject immediately without even checking the password.
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const LOGIN_DELAY_MS = 400; // flat delay on every attempt, slows automated guessing
const attempts = new Map(); // ip -> { fails, firstFailAt, lockedUntil }

function checkLockout(ip) {
  const rec = attempts.get(ip);
  if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) {
    return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false };
}

function recordFailure(ip) {
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || now - rec.firstFailAt > FAIL_WINDOW_MS) rec = { fails: 0, firstFailAt: now, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) rec.lockedUntil = now + LOCKOUT_MS;
  attempts.set(ip, rec);
}

function recordSuccess(ip) {
  attempts.delete(ip);
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  COOKIE_NAME, createSessionCookie, clearSessionCookie, isValidSession,
  checkLockout, recordFailure, recordSuccess, clientIp, delay, LOGIN_DELAY_MS,
};

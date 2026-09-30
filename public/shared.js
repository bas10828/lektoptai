// Shared behaviour for the authenticated vigi-control pages: toasts, haptics,
// hold-to-confirm for the disarm button, mode switching, and the top
// "status hero" banner. Served behind auth (falls through serveStatic), so
// it is only ever loaded by pages that are already logged in.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function haptic(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* unsupported */ }
}

// ---- toast -------------------------------------------------------------
let toastHost = null;
function toast(msg, kind) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || 'ok');
  el.textContent = msg;
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), reduceMotion ? 0 : 250);
  }, 2600);
  while (toastHost.children.length > 3) toastHost.firstChild.remove();
}

// POST helper with instant feedback. Resolves to the parsed JSON (or null).
async function act(url, body, okMsg) {
  haptic(15);
  try {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body || {}) });
    if (res.status === 401) { window.location.href = '/login'; return null; }
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error((err && err.error) || 'HTTP ' + res.status);
    }
    if (okMsg) toast(okMsg, 'ok');
    return await res.json().catch(() => null);
  } catch (e) {
    haptic([40, 40, 40]);
    toast('ไม่สำเร็จ: ' + e.message, 'bad');
    return null;
  }
}

// ---- hold-to-confirm ---------------------------------------------------
// Replaces confirm() for risky actions: a dialog is one tap too easy to
// dismiss by reflex, holding for ~1.2s is a deliberate act.
function holdToConfirm(btn, onConfirm, ms) {
  const HOLD_MS = ms || 1200;
  let timer = null;
  let t0 = 0;
  const cancel = () => {
    clearTimeout(timer); timer = null;
    btn.classList.remove('holding');
    btn.style.removeProperty('--hold-ms');
  };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    t0 = Date.now();
    btn.style.setProperty('--hold-ms', HOLD_MS + 'ms');
    btn.classList.add('holding');
    haptic(10);
    timer = setTimeout(() => { cancel(); haptic([30, 30, 60]); onConfirm(); }, HOLD_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, () => {
    if (timer && Date.now() - t0 < HOLD_MS) { cancel(); toast('กดค้างไว้เพื่อยืนยัน', 'warn'); }
  }));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // Keyboard: Enter/Space hold works via keydown/keyup pair.
  btn.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !timer && !e.repeat) {
      t0 = Date.now(); btn.classList.add('holding'); btn.style.setProperty('--hold-ms', HOLD_MS + 'ms');
      timer = setTimeout(() => { cancel(); onConfirm(); }, HOLD_MS);
    }
  });
  btn.addEventListener('keyup', () => { if (timer) { cancel(); toast('กดค้างไว้เพื่อยืนยัน', 'warn'); } });
}

// ---- header actions shared by both pages ------------------------------
function logout() {
  fetch('/logout', { method: 'POST' }).then(() => { window.location.href = '/login'; });
}

const modeLabels = { away: 'ไม่อยู่บ้าน', home: 'อยู่บ้าน', custom: 'กำหนดเอง' };

async function setMode(m) {
  // Optimistic highlight so the tap feels instant; refreshMode() corrects it
  // if the server disagrees.
  document.querySelectorAll('.mode-btn[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  window.currentMode = m;
  const r = await act('/mode/set', { mode: m }, 'เปลี่ยนโหมดเป็น "' + modeLabels[m] + '" แล้ว');
  if (!r) refreshMode();
}

function refreshMode() {
  fetch('/mode/status', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
    window.currentMode = d.mode;
    document.querySelectorAll('.mode-btn[data-mode]').forEach((b) => {
      const on = b.dataset.mode === d.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }).catch(() => { /* next refresh retries */ });
}

async function masterDisarm() {
  const [a, b] = await Promise.all([
    act('/no-parking/set-armed', { armed: false }),
    act('/intrusion/set-all-armed', { armed: false }),
  ]);
  if (a || b) toast('ปิดระบบทั้งหมดแล้ว', 'warn');
  refreshMode();
}

// ---- status hero -------------------------------------------------------
// level: ok | warn | alert | off
function setStatusHero(level, title, sub) {
  const el = document.getElementById('statusHero');
  if (!el) return;
  el.className = 'status-hero ' + level;
  el.querySelector('.sh-title').textContent = title;
  el.querySelector('.sh-sub').textContent = sub || '';
  const iconEl = el.querySelector('.sh-icon');
  if (iconEl.dataset.level !== level) {
    iconEl.dataset.level = level;
    iconEl.innerHTML = HERO_ICONS[level] || '';
  }
}

const svgIcon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const HERO_ICONS = {
  ok: svgIcon('<path d="M12 3l8 3v6c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  warn: svgIcon('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.5"/>'),
  alert: svgIcon('<path d="M6 17V11a6 6 0 0 1 12 0v6"/><path d="M4 17h16M12 3V2M4.5 5.5l-1-1M19.5 5.5l1-1M10 21h4"/>'),
  off: svgIcon('<path d="M12 3l8 3v6c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V6z"/><path d="M4 4l16 16"/>'),
};

// Live clock on every video overlay — makes it obvious the feed is current.
function tickClocks() {
  const t = new Date().toLocaleTimeString('th-TH', { hour12: false });
  document.querySelectorAll('[data-clock]').forEach((el) => { el.textContent = t; });
}
setInterval(tickClocks, 1000);

document.addEventListener('DOMContentLoaded', () => {
  tickClocks();
  document.querySelectorAll('[data-hold]').forEach((btn) => holdToConfirm(btn, masterDisarm));
  refreshMode();
  // Mode can change elsewhere (another phone, a schedule) — keep a page that
  // stays open in sync instead of showing the mode it loaded with.
  setInterval(() => { if (!document.hidden) refreshMode(); }, 5000);
});

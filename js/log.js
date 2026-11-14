/*
 * Central diagnostics log.
 * Technical events only (connection steps, errors, which screen / button) – never names, chat text,
 * secret codes or words. Batches are posted to a write-only style topic on ntfy.sh so that problems
 * seen on real phones can be investigated afterwards. Read with: tools/logs.sh
 */
export const VERSION = '2.0';
const TOPIC = (typeof window !== 'undefined' && window.__dvLogTopic) || 'dv5g-logs-k7q2m9x4t1';
const URL_ = 'https://ntfy.sh/' + TOPIC;
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const isLocalHost = typeof location !== 'undefined' && /^(localhost|127\.|\[::1\])/.test(location.hostname);
// no remote logging in automated/local runs unless a test asks for it explicitly
const ENABLED = typeof window !== 'undefined' && (!!window.__dvLogTopic || (!params.has('local') && !isLocalHost));
const MAX_POSTS_PER_DAY = 120;
const T0 = Date.now();

function ls(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch { /* ignore */ }
  return null;
}
export const dev = (() => {
  let d = ls('dv:logdev');
  if (!d) { d = Math.random().toString(36).slice(2, 7); ls('dv:logdev', d); }
  return d;
})();
const run = Math.random().toString(36).slice(2, 5); // one page load

export const ring = [];      // last lines, shown in the on-screen "technical details"
let pending = [];
let timer = null;
let seq = 0;
let ctx = '';                // "host 1234" – set by the app
let sending = false;

export function setLogContext(c) { ctx = c; }

function budgetOk() {
  const day = new Date().toISOString().slice(0, 10);
  let [d, n] = (ls('dv:logbudget') || '').split('|');
  if (d !== day) { d = day; n = 0; }
  n = +n || 0;
  if (n >= MAX_POSTS_PER_DAY) return false;
  ls('dv:logbudget', d + '|' + (n + 1));
  return true;
}

export function log(ev, data, urgent) {
  const t = ((Date.now() - T0) / 1000).toFixed(1);
  let extra = '';
  if (data !== undefined && data !== null) {
    try { extra = ' ' + (typeof data === 'string' ? data : JSON.stringify(data)); } catch { extra = ' ?'; }
  }
  const line = `${t} ${ev}${extra}`.slice(0, 400);
  ring.push(line);
  if (ring.length > 250) ring.shift();
  if (!ENABLED) return;
  pending.push(line);
  if (pending.length > 400) pending.splice(0, pending.length - 400);
  schedule(urgent ? 1500 : 12000);
}

function schedule(ms) {
  if (timer && timer.at <= Date.now() + ms) return;
  if (timer) clearTimeout(timer.id);
  timer = { at: Date.now() + ms, id: setTimeout(() => { timer = null; flush(); }, ms) };
}

export function flush(final) {
  if (!ENABLED || !pending.length || (sending && !final)) return Promise.resolve(false);
  if (!budgetOk()) { pending = []; return Promise.resolve(false); }
  const head = `#${dev}.${run} v${VERSION} ${ctx || '-'} n${seq++}`;
  let body = head;
  let used = 0;
  for (const l of pending) {
    if (body.length + l.length + 1 > 3600) break;
    body += '\n' + l; used++;
  }
  const sent = pending.slice(0, Math.max(used, 1));
  pending = pending.slice(sent.length);
  sending = true;
  return fetch(URL_, { method: 'POST', body, keepalive: true })
    .then(r => { sending = false; if (pending.length) schedule(4000); return r.ok; })
    .catch(() => { sending = false; pending = sent.concat(pending).slice(-400); return false; });
}

if (typeof window !== 'undefined') {
  const nav = navigator;
  const conn = nav.connection || {};
  log('boot', {
    ua: nav.userAgent, lang: nav.language, online: nav.onLine,
    net: conn.effectiveType || '', type: conn.type || '', save: !!conn.saveData,
    w: window.innerWidth, h: window.innerHeight, standalone: !!(nav.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)),
    ref: document.referrer ? new URL(document.referrer).hostname : '', q: [...params.keys()].join(','),
  }, true);
  window.addEventListener('error', e => log('js-error', `${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`, true));
  window.addEventListener('unhandledrejection', e => log('js-reject', String(e.reason && (e.reason.message || e.reason)).slice(0, 200), true));
  window.addEventListener('online', () => log('online', null, true));
  window.addEventListener('offline', () => log('offline', null, true));
  document.addEventListener('visibilitychange', () => {
    log('vis', document.visibilityState);
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', () => { log('pagehide'); flush(true); });
  // which buttons people press (never keyboard keys / board cells, which could reveal a secret)
  document.addEventListener('click', e => {
    const b = e.target && e.target.closest && e.target.closest('.btn, .link-btn, .icon-btn, .game-row, .fab, .quick button');
    if (!b) return;
    const kind = b.classList.contains('game-row') ? 'game-row' : b.classList.contains('quick') ? 'quick' : 'btn';
    const label = b.dataset.log || (kind === 'game-row' ? (b.querySelector('b') || b).textContent : b.textContent);
    log('tap', (label || '').replace(/\s+/g, ' ').trim().slice(0, 24) + (b.disabled ? ' (disabled)' : ''));
  }, true);
  setInterval(() => { if (pending.length) schedule(1); }, 60000);
}

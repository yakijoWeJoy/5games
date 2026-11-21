/*
 * Product analytics (PostHog). Separate from log.js, which is a short-lived technical log for debugging.
 *
 * What is sent: anonymous events about how the product is used (screens, rooms, invites, games, series,
 * tutorials, connection quality). Never names, notes text, secret codes, words or board moves.
 * Identity is a random id kept in this browser (no cookies). Browsers that send Global Privacy
 * Control are not tracked. Events are batched, kept in localStorage while offline, and carry a uuid
 * so a re-sent batch is not counted twice. Event dictionary and dashboards: ANALYTICS.md
 *
 * To switch on: put the PostHog *project* API key (phc_…, safe to publish) in POSTHOG_KEY.
 */
import { VERSION } from './log.js';

const POSTHOG_KEY = 'phc_kH4Ts6iyuRaxCsJB5N99aj4v9Bqu6n3WbBvqBFcKNiQ4'; // project key: can only send events, safe to publish
const POSTHOG_HOST = 'https://eu.i.posthog.com';

const W = typeof window !== 'undefined' ? window : null;
const over = (W && W.__dvAnalytics) || null;              // tests: { key, host }
const KEY = (over && over.key) || POSTHOG_KEY;
const HOST = ((over && over.host) || POSTHOG_HOST).replace(/\/$/, '');
const params = new URLSearchParams(W ? location.search : '');
const isLocalHost = W && /^(localhost|127\.|\[::1\])/.test(location.hostname);
const gpc = W && navigator.globalPrivacyControl === true;
export const ENABLED = !!(W && KEY && !gpc && (over || (!params.has('local') && !params.has('demo') && !isLocalHost)));

const MAX_PER_DAY = 1500;        // protects the free tier from a runaway loop
const MAX_QUEUE = 300;
const SESSION_IDLE = 30 * 60 * 1000;

function ls(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  } catch { /* storage blocked */ }
  return null;
}
const json = (k, d) => { try { return JSON.parse(ls(k)) ?? d; } catch { return d; } };

/** RFC 9562 UUIDv7 (time ordered) – PostHog expects these for session ids */
export function uuidv7(t = Date.now()) {
  const b = new Uint8Array(16);
  (W && W.crypto ? crypto : globalThis.crypto).getRandomValues(b);
  for (let i = 0; i < 6; i++) b[i] = Math.floor(t / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/* ---------- identity, session, lifetime counters ---------- */

let distinctId = null, firstSeen = null, isNewUser = false, counters = {}, session = null;
function initIdentity() {
  distinctId = ls('dv:aid');
  if (!distinctId) { distinctId = uuidv7(); ls('dv:aid', distinctId); isNewUser = true; }
  firstSeen = +ls('dv:afirst') || 0;
  if (!firstSeen) { firstSeen = Date.now(); ls('dv:afirst', String(firstSeen)); }
  counters = json('dv:acount', {});
}
function sessionId() {
  const now = Date.now();
  if (!session) session = json('dv:asess', null);
  if (!session || now - session.last > SESSION_IDLE) {
    session = { id: uuidv7(now), start: now, last: now };
    bump('sessions');
  }
  session.last = now;
  ls('dv:asess', JSON.stringify(session));
  return session.id;
}
/** lifetime counters of this device (sent as person properties) */
export function bump(name, by = 1) {
  if (!ENABLED) return 0;
  counters[name] = (counters[name] || 0) + by;
  ls('dv:acount', JSON.stringify(counters));
  return counters[name];
}

/* ---------- device context ---------- */

function device() {
  const ua = navigator.userAgent || '';
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPod/.test(ua) || ipad ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac OS X' : /CrOS/.test(ua) ? 'Chrome OS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser = /musical_ly|BytedanceWebview|TikTok|trill_/i.test(ua) ? 'In-app (TikTok)' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Instagram/.test(ua) ? 'In-app (Instagram)' : /FBAN|FBAV|FB_IAB/.test(ua) ? 'In-app (Facebook)' : /WhatsApp/.test(ua) ? 'In-app (WhatsApp)'
    : /Edg\//.test(ua) ? 'Microsoft Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Other';
  const tablet = ipad || (/Android/.test(ua) && !/Mobile/.test(ua));
  const conn = navigator.connection || {};
  return {
    $os: os, $browser: browser, $device_type: tablet ? 'Tablet' : /Mobi|iPhone|Android/.test(ua) ? 'Mobile' : 'Desktop',
    $screen_width: screen.width, $screen_height: screen.height, $viewport_width: innerWidth, $viewport_height: innerHeight,
    $raw_user_agent: ua.slice(0, 300),
    lang: navigator.language || '', net_type: conn.effectiveType || null, save_data: !!conn.saveData,
    standalone: !!(navigator.standalone || (W.matchMedia && matchMedia('(display-mode: standalone)').matches)),
  };
}

/* ---------- capture & transport ---------- */

let queue = [], timer = null, sending = false, dev = null, role = null, failures = 0;
const superProps = {};

/** properties attached to every following event (e.g. role, room) */
export function setContext(props) {
  for (const [k, v] of Object.entries(props)) { if (v == null) delete superProps[k]; else superProps[k] = v; }
  if ('role' in props) role = props.role;
}

function budgetOk() {
  const day = new Date().toISOString().slice(0, 10);
  let [d, n] = (ls('dv:abudget') || '').split('|');
  n = d === day ? +n || 0 : 0;
  if (n >= MAX_PER_DAY) return false;
  ls('dv:abudget', day + '|' + (n + 1));
  return true;
}

export function track(event, props, opts) {
  if (!ENABLED || !budgetOk()) return;
  const now = Date.now();
  const p = {
    distinct_id: distinctId, $session_id: sessionId(), $lib: 'dv-web', $lib_version: VERSION,
    app_version: VERSION, $current_url: location.origin + location.pathname, $host: location.host, $pathname: location.pathname,
    days_since_first_seen: Math.floor((now - firstSeen) / 86400000),
    ...dev, ...superProps, ...props,
  };
  if (opts && opts.set) p.$set = opts.set;
  if (opts && opts.setOnce) p.$set_once = opts.setOnce;
  queue.push({ event, uuid: uuidv7(now), timestamp: new Date(now).toISOString(), properties: p });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  persist();
  schedule(opts && opts.now ? 300 : queue.length >= 20 ? 1000 : 8000);
}

// Each tab keeps its unsent events under its own key, so two tabs of one browser never overwrite
// each other. A tab holds a Web Lock while it lives; the next visit adopts only the queues of tabs that are gone.
const TAB = Math.random().toString(36).slice(2, 8);
function persist() { ls('dv:aq:' + TAB, queue.length ? JSON.stringify({ t: Date.now(), q: queue }) : null); }
async function adoptLeftovers() {
  let held = null;
  try {
    if (navigator.locks) {
      navigator.locks.request('dv-aq-' + TAB, () => new Promise(() => { /* held for the life of the tab */ })).catch(() => {});
      const q = await navigator.locks.query();
      held = new Set((q.held || []).map(l => l.name));
    }
  } catch { held = null; }
  const got = [];
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('dv:aq:') || k === 'dv:aq:' + TAB) continue;
      const v = json(k, null);
      const alive = held ? held.has('dv-aq-' + k.slice(6)) : v && Date.now() - v.t < 120000;
      if (alive) continue;
      if (v && Array.isArray(v.q)) got.push(...v.q);
      localStorage.removeItem(k);
    }
  } catch { /* storage blocked */ }
  const have = new Set(queue.map(e => e.uuid));
  const add = got.filter(e => e && e.uuid && e.event && !have.has(e.uuid));
  if (!add.length) return;
  queue = add.concat(queue).slice(-MAX_QUEUE);
  persist();
  schedule(1500);
}

function schedule(ms) {
  if (timer && timer.at <= Date.now() + ms) return;
  if (timer) clearTimeout(timer.id);
  timer = { at: Date.now() + ms, id: setTimeout(() => { timer = null; flush(); }, ms) };
}

/** send what is queued; `final` = the page is going away (keepalive request, no waiting) */
export function flush(final) {
  if (!ENABLED || !queue.length || (sending && !final)) return Promise.resolve(false);
  // keepalive bodies are limited to 64KB in total – stay well below
  const batch = [];
  let size = 0;
  for (const e of queue) {
    const n = JSON.stringify(e).length;
    if (batch.length && size + n > 45000) break;
    batch.push(e); size += n;
  }
  const body = JSON.stringify({ api_key: KEY, batch, sent_at: new Date().toISOString() });
  sending = true;
  // text/plain keeps this a "simple" request: no CORS preflight, works with keepalive on every browser
  return fetch(HOST + '/batch/', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } })
    .then(r => {
      sending = false;
      if (!r.ok && r.status !== 400) throw new Error('http ' + r.status); // 400 = a bad event – drop it rather than retry forever
      const sent = new Set(batch.map(e => e.uuid));
      queue = queue.filter(e => !sent.has(e.uuid));
      persist();
      failures = 0;
      if (queue.length) schedule(1000);
      return true;
    })
    .catch(() => {
      sending = false;
      failures++;
      if (!final) schedule(Math.min(5 * 60000, 5000 * 2 ** Math.min(failures, 6)));
      return false;
    });
}

/* ---------- page view & lifecycle ---------- */

let viewStart = 0, lastScreen = null;

/**
 * The campaign that first brought this device (utm_source, or "tiktok" for a TikTok ad click).
 * It rides along on the invite links this player sends, so a friend who arrives through the invite
 * is still credited to the campaign (src=…): that is the campaign's viral reach.
 */
const clean = v => String(v || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
export function campaignSource() {
  let src = ls('dv:asrc');
  if (src) return src;
  src = clean(params.get('utm_source')) || (params.get('ttclid') ? 'tiktok' : '') || (params.get('fbclid') ? (/Instagram/.test(navigator.userAgent) ? 'instagram' : 'meta') : '') || clean(params.get('src'));
  if (src) ls('dv:asrc', src);
  return src || '';
}

/** call once per page load. entry: invite_link | resume | direct */
export function trackPageview(entry) {
  if (!ENABLED) return;
  const ref = document.referrer ? new URL(document.referrer) : null;
  const refHost = ref && ref.host !== location.host ? ref.host : '';
  const utm = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) if (params.get(k)) utm[k] = params.get(k).slice(0, 80);
  // TikTok adds ttclid to ad clicks; only the fact is kept, not the id
  if (params.get('ttclid')) { utm.from_ad_click = true; if (!utm.utm_source) utm.utm_source = 'tiktok'; }
  // Meta (Instagram / Facebook) adds fbclid to clicks; again only the fact is kept
  if (params.get('fbclid')) { utm.from_meta_click = true; if (!utm.utm_source) utm.utm_source = /Instagram/.test(navigator.userAgent) ? 'instagram' : 'meta'; }
  if (params.has('back')) utm.came_back_by_partner_message = true; // the friend messaged "I'm here" and this phone came back
  const invitedFrom = clean(params.get('src'));
  if (invitedFrom) utm.invited_from_source = invitedFrom;
  const src = campaignSource();
  viewStart = Date.now();
  track('$pageview', {
    entry, $referrer: refHost ? ref.origin + ref.pathname : '$direct', $referring_domain: refHost || '$direct', ...utm,
    is_new_user: isNewUser, campaign_source: src || null,
  }, {
    now: true,
    setOnce: {
      first_seen_at: new Date(firstSeen).toISOString(), first_version: VERSION, first_entry: entry,
      $initial_referring_domain: refHost || '$direct', acquisition_source: src || (refHost || 'direct'), acquired_via_invite_from: invitedFrom || null, $initial_os: dev.$os, $initial_device_type: dev.$device_type,
      ...Object.fromEntries(Object.entries(utm).map(([k, v]) => ['$initial_' + k, v])),
    },
    set: { last_version: VERSION, $os: dev.$os, $browser: dev.$browser, $device_type: dev.$device_type, lang: dev.lang, ...lifetime() },
  });
}

export function lifetime() {
  const c = counters;
  return { lifetime_sessions: c.sessions || 0, lifetime_rooms_hosted: c.rooms_hosted || 0, lifetime_rooms_joined: c.rooms_joined || 0, lifetime_games_completed: c.games_completed || 0, lifetime_series_completed: c.series_completed || 0 };
}

/** a coarse screen name (home, invite, menu, game, result …) – only sent when it changes */
export function trackScreen(screen, props) {
  if (!ENABLED || screen === lastScreen) return;
  lastScreen = screen;
  track('screen_viewed', { screen, ...props });
}

if (ENABLED) {
  initIdentity();
  dev = device();
  adoptLeftovers();
  let errors = 0;
  W.addEventListener('error', e => {
    const file = (e.filename || '').split('/').pop().split('?')[0];
    if (!file || /ethereum|solana|__gCrWeb|webkit\.messageHandlers/.test(e.message || '') || ++errors > 5) return; // browser add-ons / flood
    track('js_error', { message: String(e.message || '').slice(0, 160), file, line: e.lineno || 0, screen: lastScreen }, { now: true });
  });
  W.addEventListener('unhandledrejection', e => {
    if (++errors > 5) return;
    track('js_error', { message: String(e.reason && (e.reason.message || e.reason)).slice(0, 160), file: 'promise', screen: lastScreen });
  });
  W.addEventListener('online', () => schedule(500));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
    else if (queue.length) schedule(500);
  });
  W.addEventListener('pagehide', () => {
    if (viewStart) track('$pageleave', { duration_s: Math.round((Date.now() - viewStart) / 1000), last_screen: lastScreen, role });
    flush(true);
  });
}

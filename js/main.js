import { h, toast, confirmBox, tally, buzz, rid } from './ui.js';
import { Link, LOCAL } from './net.js';
import { play, soundOn, setSound } from './sound.js';
import { log, flush as flushLog, setLogContext, dev as logDev, ring as logRing, VERSION } from './log.js';
import { track, trackPageview, trackScreen, setContext, bump, lifetime, flush as flushAnalytics, campaignSource } from './analytics.js';
import { gameEvents } from './metrics.js';
import { GAMES, BY, STATE_V, NEED, cleanName, newState, reduce, seriesWins, seriesDone, seriesDecided, seriesLeader, nextGame } from './core.js';
import { T, LANG, setLang } from './i18n.js';
import { registerServiceWorker, installLink, installCard } from './install.js';

const params = new URLSearchParams(location.search);
const NS = 'dv:' + (params.get('local') || '') + ':';

// A second tab of the same browser (e.g. trying the game alone on a computer) keeps its own
// session in sessionStorage, so the two tabs do not fight over one saved identity.
let backing = null;
try { backing = window.localStorage; } catch { /* storage blocked */ }
const store = {
  get(k, d) { try { const v = backing.getItem(NS + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { backing.setItem(NS + k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { backing.removeItem(NS + k); } catch { /* ignore */ } },
};
async function claimPrimaryTab() {
  if (LOCAL || !navigator.locks) return;
  try {
    const got = await new Promise(res => {
      navigator.locks.request('dv-primary-tab', { ifAvailable: true }, lock => {
        res(!!lock);
        return lock ? new Promise(() => { /* hold for the life of the tab */ }) : undefined;
      }).catch(() => res(true));
    });
    if (!got) backing = window.sessionStorage;
  } catch { /* ignore */ }
}

const app = document.getElementById('app');
let session = null;
let state = null;
let net = null;
let link = 'waiting';
let me = 0;
let prevMyTurn = null;
let prevGameKey = null;
let seenChat = null;
let chatOpen = false;
let unread = 0;
let outbox = [];        // guest: actions sent but not yet confirmed by the host
let outboxTimer = null;
let loggedOver = null;
let lastOverKey = null;
let stateSeen = false;
let helpEl = null;
let lastView = null;
let techOpen = false;
let installClosed = false; // the "add to home screen" card was put away on this visit
let seenState = null;   // analytics: the last state this phone saw (to tell what changed)
let netT0 = 0;          // analytics: when this phone started connecting
let everLinked = false; // analytics: linked at least once since startNet
let problemSince = 0;   // analytics: when the current connection problem started
let problemStatus = null;
const DEMO = params.has('demo'); // canned screens for visual tests, no network

/* ======================= dispatching actions ======================= */

function commit(s) {
  s.rev++;
  state = s;
  store.set('state:' + session.code, s);
  net && net.send({ t: 'state', s });
  onState();
}

function hostDispatch(p, a, ackId) {
  let s = structuredClone(state);
  const ok = reduce(s, p, a, { test: !!window.__dvTest });
  if (!ok) {
    if (!ackId) return;
    s = structuredClone(state); // the action was refused – still confirm it so the guest stops re-sending
  }
  if (ackId) { s.acks = [...(s.acks || []), ackId].slice(-40); }
  commit(s);
}

/** Add the context the action was made in, so a late/duplicated action can never hit a different game. */
function withContext(a) {
  const gid = state && state.game ? state.game.id : null;
  if (a.k === 'g') return { ...a, gid };
  if (a.k === 'next' || a.k === 'replay' || a.k === 'menu') return { ...a, from: gid };
  if (a.k === 'newSeries') return { ...a, from: gid, n: state.series.n };
  return a;
}

function act(a0) {
  const a = withContext(a0);
  if (DEMO) { const s = structuredClone(state); if (reduce(s, me, a, { test: true })) { s.rev++; state = s; onState(); } return; }
  if (session.role === 'host') { hostDispatch(0, a); return; }
  if (link !== 'linked') { toast(T('אין חיבור כרגע… מנסה להתחבר שוב', 'No connection right now… trying to reconnect')); net && net.wake(); return; }
  const msg = { t: 'act', id: rid(10), a };
  outbox.push({ msg, t: Date.now(), sent: Date.now() });
  net.send(msg);
}

function flushOutbox(force) {
  if (!outbox.length || !net) return;
  const now = Date.now();
  const keep = [];
  let dropped = false;
  for (const o of outbox) {
    if (now - o.t > 25000) { dropped = true; continue; }
    if (link === 'linked' && (force || now - o.sent > 2500)) { o.sent = now; net.send(o.msg); }
    keep.push(o);
  }
  outbox = keep;
  if (dropped) toast(T('הפעולה האחרונה לא נשלחה – נסו שוב', 'Your last move was not sent – please try again'));
}

/* ======================= networking ======================= */

function startNet() {
  me = session.role === 'host' ? 0 : 1;
  outbox = [];
  clearInterval(outboxTimer);
  setLogContext(`${session.role} ${session.code}`);
  setContext({ role: session.role });
  netT0 = Date.now(); everLinked = false; problemSince = 0; problemStatus = null;
  const onStatus = st => {
    const was = link;
    link = st;
    connAnalytics(st, was);
    if (st === 'linked' && session.role === 'guest') flushOutbox(true);
    if (st === 'linked' && was !== 'linked' && state && state.players[1].token) buzz(30);
    render();
  };
  if (session.role === 'host') {
    net = new Link('host', session.code, {
      roomId: () => state.sid,
      guestToken: () => state.players[1].token,
      accept: d => !!d.token && !(state.banned || []).includes(d.token) && (!state.players[1].token || state.players[1].token === d.token),
      onHello: d => {
        const s = structuredClone(state);
        const first = !s.players[1].token;
        s.players[1] = { name: cleanName(d.name), token: d.token };
        commit(s);
        if (first) {
          toast(T(`${s.players[1].name} הצטרף/ה לדף! ✏️`, `${s.players[1].name} joined! ✏️`)); buzz([40, 60, 40]); play('join');
          track('partner_joined', { room_id: s.sid, seconds_waiting: session.created ? Math.round((Date.now() - session.created) / 1000) : null, is_replacement: !!(s.banned && s.banned.length) }, { now: true });
        }
      },
      onMessage: d => {
        if (d.t !== 'act') return;
        if (d.id && (state.acks || []).includes(d.id)) { net.send({ t: 'state', s: state }); return; } // duplicate
        hostDispatch(1, d.a, d.id);
      },
      onStatus,
      // the 4-digit code is already used by somebody else right now – quietly take another one
      isFresh: () => !!session.fresh && !state.players[1].token,
      onIdTaken: () => {
        if (!session.fresh || state.players[1].token) return false;
        const old = session.code;
        session.code = newCode();
        store.set('session', session);
        store.del('state:' + old);
        store.set('state:' + session.code, state);
        net.destroy();
        startNet();
        render();
        return true;
      },
    });
    if (session.fresh) setTimeout(() => { if (session && session.fresh) { session.fresh = false; store.set('session', session); } }, 8000);
  } else {
    net = new Link('guest', session.code, {
      roomId: () => (state ? state.sid : null),
      hello: () => ({ t: 'hello', token: session.token, name: session.name }),
      onMessage: d => {
        if (d.t === 'state' && d.s) {
          if (d.s.v !== STATE_V) { versionMismatch(d.s.v); return; }
          if (state && d.s.sid && d.s.sid === state.sid && d.s.rev < state.rev) return; // an older copy that arrived late
          state = d.s;
          store.set('gstate:' + session.code, state);
          const acks = state.acks || [];
          outbox = outbox.filter(o => !acks.includes(o.msg.id));
          onState();
        }
      },
      onStatus,
    });
    outboxTimer = setInterval(() => flushOutbox(false), 1000);
  }
  net.start();
}

/** connection quality as the player feels it: time to connect, problems, recoveries */
function connAnalytics(st, was) {
  const inGame = !!(state && state.game && !state.game.over);
  if (st === 'linked' && was !== 'linked') {
    const viaDirect = net && net.info().channels.some(c => c.open && !c.name.startsWith('relay'));
    if (!everLinked) {
      everLinked = true;
      // guest: from pressing "join" (or reopening) to playing together; host: until the partner's phone answers
      track('connected', { ms: Date.now() - netT0, resumed: session.role === 'guest' ? !session.justJoined : null, direct: viaDirect }, { now: true });
      if (session.justJoined) { session.justJoined = false; store.set('session', session); }
    } else if (problemSince) {
      track('connection_recovered', { problem: problemStatus, seconds_down: Math.round((Date.now() - problemSince) / 1000), in_game: inGame, direct: viaDirect });
    }
    problemSince = 0; problemStatus = null;
    return;
  }
  // only real problems: "waiting" while nobody joined yet is normal for a host
  const bad = st === 'offline' || st === 'no-host' || st === 'full' || (st === 'waiting' && everLinked);
  if (bad && st !== problemStatus) {
    if (!problemSince) problemSince = Date.now();
    problemStatus = st;
    track('connection_problem', { status: st, was_linked: everLinked, in_game: inGame, seconds_since_start: Math.round((Date.now() - netT0) / 1000) });
  }
}

/** the two phones run different versions of the site (one of them has an old copy cached) */
function versionMismatch(v) {
  log('version-mismatch', `theirs ${v} mine ${STATE_V}`, true);
  track('version_mismatch', { theirs: v, mine: STATE_V }, { now: true });
  let tried = false;
  try { tried = sessionStorage.getItem('dv:reloaded') === String(v); sessionStorage.setItem('dv:reloaded', String(v)); } catch { /* ignore */ }
  if (v > STATE_V && !tried) { location.reload(); return; }
  toast(v > STATE_V ? T('צריך לרענן את הדף בטלפון הזה כדי לקבל את הגרסה החדשה', 'Please refresh the page on this phone to get the new version') : T('בטלפון השני יש גרסה ישנה – צריך לרענן שם את הדף', 'The other phone has an old version – please refresh the page there'), null, 6000);
}

const newCode = () => {
  if (window.__dvForceCode) { const c = window.__dvForceCode; window.__dvForceCode = null; return c; } // test hook
  return String(Math.floor(1000 + Math.random() * 9000));
};

/* ======================= reacting to state ======================= */

function ctxFor() {
  const names = state.players.map((p, i) => p.name || (i === 0 ? T('מארח', 'Host') : T('אורח', 'Guest')));
  return { me, other: 1 - me, names, send: a => act({ k: 'g', a }) };
}

function onState() {
  // product analytics: games / series started, finished, abandoned (both phones report, tagged with role)
  for (const e of gameEvents(seenState, state, me)) {
    let set;
    if (e.event === 'game_completed') set = { lifetime_games_completed: bump('games_completed') };
    if (e.event === 'series_completed') set = { lifetime_series_completed: bump('series_completed') };
    track(e.event, e.props, set ? { set } : undefined);
  }
  seenState = state;
  // chat notifications
  if (seenChat === null) seenChat = new Set(state.chat.map(m => m.id));
  for (const m of state.chat) {
    if (seenChat.has(m.id)) continue;
    seenChat.add(m.id);
    if (m.p !== me) {
      buzz([30, 40, 30]);
      play('note');
      if (!chatOpen) { unread++; toast(m.text, T(`✉️ פתק מ${state.players[m.p].name}`, `✉️ Note from ${state.players[m.p].name}`), 3800); }
    }
  }
  // game switched by the other player
  const key = state.game ? state.game.id : null;
  if (prevGameKey !== undefined && prevGameKey !== null && key === null && state.leftBy !== me) {
    toast(T(`${state.players[1 - me].name} חזר/ה לתפריט`, `${state.players[1 - me].name} went back to the menu`));
  }
  const newGame = key !== prevGameKey && !!key;
  if (newGame) log('game-start', state.current);
  if (state.game && state.game.over && loggedOver !== key) { loggedOver = key; log('game-over', `${state.current} ${state.game.over.winner === null ? 'tie' : state.game.over.winner === me ? 'me' : 'other'}`); }
  prevGameKey = key;
  // my turn?
  let mine = false;
  if (state.game && !state.game.over) mine = BY[state.current].status(state.game, ctxFor()).mine;
  if (mine && prevMyTurn === false) { buzz(60); play('turn'); }
  prevMyTurn = mine;
  // end of a game: a short tune (not when the page is just opened on a finished game)
  const overKey = state.game && state.game.over ? key : null;
  if (stateSeen && overKey && overKey !== lastOverKey) {
    const w = state.game.over.winner;
    play(w == null ? 'tie' : w === me ? 'win' : 'lose');
  }
  lastOverKey = overKey;
  stateSeen = true;

  render();
  renderChat();
  // first time this phone plays this game: a short "how to play"
  if (newGame && !state.game.over) maybeHelp(BY[state.current]);
  else if (!state.game && helpEl) closeHelp();
}

/* ======================= turn indicator ======================= */

/** who holds the pencil right now: me | other | null (both act at once, or no game) */
function turnInfo(ctx) {
  if (!state || !state.game || state.game.over) return { mine: false, holder: null, st: null };
  const G = BY[state.current], g = state.game;
  const st = G.status(g, ctx);
  const together = g.phase === 'secret' || g.phase === 'word' || g.phase === 'place';
  return { mine: st.mine, holder: together ? null : st.mine ? me : 1 - me, st };
}

function applyTurnLook(ti) {
  const b = document.body;
  b.style.setProperty('--me-ink', `var(--ink${me})`);
  b.classList.toggle('my-turn', !!ti.st && ti.mine);
  b.classList.toggle('their-turn', !!ti.st && !ti.mine);
  const want = ti.st && ti.mine ? T('✏️ תורך! · דף ועיפרון', '✏️ Your turn! · Paper & Pencil') : T('דף ועיפרון', 'Paper & Pencil');
  if (document.title !== want) document.title = want;
}

function turnBanner(G, ctx, ti) {
  const help = h('button', { class: 'help-btn', 'data-log': 'help', 'aria-label': T('איך משחקים?', 'How to play?'), title: T('איך משחקים?', 'How to play?'), onclick: () => showHelp(G, false) }, '?');
  if (ti.mine) {
    return h('div', { class: 'turn mine', role: 'status' },
      h('span', { class: 'turn-ico' }, '✏️'), h('span', { class: 'turn-txt' }, ti.st.text), help);
  }
  return h('div', { class: 'turn wait', role: 'status' },
    h('span', { class: 'turn-pencil', 'aria-hidden': 'true' }, '✎'), h('span', { class: 'turn-txt' }, ti.st.text), help);
}

/* ======================= how to play ======================= */

function helpSeen(id) { return !!store.get('help:' + id, false); }

function maybeHelp(G) {
  if (window.__dvNoHelp) return;
  if (DEMO ? !params.has('help') : helpSeen(G.id)) return;
  showHelp(G, true);
}

function closeHelp() { if (helpEl) { helpEl.remove(); helpEl = null; } }

function showHelp(G, auto) {
  closeHelp();
  const t0 = Date.now();
  log('help', `${G.id} ${auto ? 'auto' : 'asked'}`);
  track('tutorial_viewed', { game: G.id, trigger: auto ? 'auto' : 'asked', in_game_phase: state && state.game ? state.game.phase || null : null });
  const done = () => {
    store.set('help:' + G.id, true);
    log('help-ok', `${G.id} ${Math.round((Date.now() - t0) / 1000)}s`);
    track('tutorial_closed', { game: G.id, trigger: auto ? 'auto' : 'asked', seconds_open: Math.round((Date.now() - t0) / 1000) });
    closeHelp();
  };
  helpEl = h('div', { class: 'modal-bg help-bg' },
    h('div', { class: 'modal card help-card', role: 'dialog', 'aria-label': T('איך משחקים ', 'How to play ') + G.title },
      h('h3', {}, T(`איך משחקים ${G.title}?`, `How to play ${G.title}`)),
      h('ul', { class: 'help-list' }, (G.help || []).map(l => h('li', { html: l }))),
      h('button', { class: 'btn marker', 'data-log': 'help-ok', onclick: done }, T('הבנתי ✓', 'Got it ✓')),
      auto ? h('div', { class: 'soft help-foot' }, T('אפשר לפתוח שוב בכל רגע עם ה-? למעלה', 'You can open this again any time with the ? at the top')) : null));
  helpEl.addEventListener('click', e => { if (e.target === helpEl) done(); });
  document.body.append(helpEl);
}

/* ======================= rendering ======================= */

function viewIs(v) {
  if (v === lastView) return;
  lastView = v; log('view', v);
  // coarse screen for analytics: "game:bull:secret" -> game (game=bull, phase=secret)
  const [kind, game, phase] = v.split(':');
  const screen = kind === 'over' ? 'result' : kind;
  trackScreen(screen + (game ? ':' + game : '') + (phase ? ':' + phase : ''), { screen_type: screen, game: game || null, phase: phase || null });
}

// The game area is a persistent element: a game keeps its own DOM (scroll position, half-typed input)
// while the header and banners above it are refreshed.
const topEl = h('div', { class: 'top-slot' });
const bodyEl = h('div', { class: 'body-slot' });

function render() {
  if (!session) return;
  if (!state) { viewIs('connecting'); renderConnecting(); return; }
  const inGame = !!(state.current && state.game);
  viewIs(inGame ? (state.game.over ? 'over:' : 'game:') + state.current + (state.game.phase ? ':' + state.game.phase : '') : (state.players[1].token ? 'menu' : 'invite'));
  if (topEl.parentNode !== app || bodyEl.parentNode !== app) { bodyEl.replaceChildren(); bodyEl.dataset.gid = ''; app.replaceChildren(topEl, bodyEl); }
  const ctx = ctxFor();
  const top = [header(ctx)];
  let G = null;
  if (inGame) {
    G = BY[state.current];
    if (link !== 'linked') top.push(connNote());
    if (state.game.over) top.push(resultCard(G, ctx));
    else top.push(turnBanner(G, ctx, turnInfo(ctx)));
  }
  const ti = turnInfo(ctx);
  applyTurnLook(ti);
  // keep the keyboard open if the player was typing while an update arrived
  const act0 = document.activeElement;
  const fk = act0 && app.contains(act0) && act0.dataset ? act0.dataset.fk : null;
  const sel = fk ? [act0.selectionStart, act0.selectionEnd] : null;
  topEl.replaceChildren(...top);
  if (inGame) {
    if (bodyEl.dataset.gid !== state.game.id) { bodyEl.replaceChildren(); bodyEl.dataset.gid = state.game.id; window.scrollTo(0, 0); }
    bodyEl.className = 'body-slot game' + (ti.st && !ti.mine ? ' wait' : '');
    G.render(bodyEl, state.game, ctx);
  } else {
    bodyEl.dataset.gid = '';
    bodyEl.className = 'body-slot';
    bodyEl.replaceChildren(menuView(ctx));
  }
  if (fk) {
    const el = app.querySelector(`[data-fk="${fk}"]`);
    if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); try { el.setSelectionRange(sel[0], sel[1]); } catch { /* ignore */ } }
  }
  ensureChatFab();
}

function header(ctx) {
  const sw = seriesWins(state);
  const total = p => sw[p];
  const online = link === 'linked';
  const holder = turnInfo(ctx).holder;
  const tag = p => h('div', { class: `ptag p${p}${p === me ? ' me' : ''}${p === holder ? ' holder' : ''}` },
    p === holder ? h('span', { class: 'holder-ico', title: T('העיפרון אצל ', 'The pencil is with ') + (state.players[p].name || '') }, '✏️') : null,
    p !== me ? h('span', { class: 'dot' + (online ? ' on' : ''), title: online ? T('מחובר', 'Connected') : T('לא מחובר', 'Not connected') }) : null,
    h('span', { class: 'pname' }, state.players[p].name || '…'),
    h('span', { class: 'ptot' }, total(p)));
  const joined = !!state.players[1].token;
  return h('header', { class: 'top' },
    h('div', { class: 'top-btns' },
      state.current
        ? h('button', { class: 'icon-btn', 'data-log': 'to-table', onclick: leaveGame }, '☰', h('span', { class: 'lbl' }, T(' טבלה', ' Table')))
        : h('div', { class: 'logo' }, T('דף ועיפרון', 'Paper & Pencil')),
      joined ? h('button', { class: 'icon-btn chat-btn', 'data-log': 'chat', onclick: openChat }, '✉️', h('span', { class: 'lbl' }, T(' פתק', ' Note')), unread ? h('span', { class: 'badge' }, unread) : null) : null,
      joined ? h('button', {
        class: 'icon-btn sound-btn', 'data-log': soundOn() ? 'sound-off' : 'sound-on', 'aria-label': soundOn() ? T('השתקת צלילים', 'Mute sounds') : T('הפעלת צלילים', 'Turn sounds on'),
        onclick: () => { setSound(!soundOn()); track('sound_toggled', { on: soundOn() }); toast(soundOn() ? T('צלילים פועלים 🔔', 'Sounds on 🔔') : T('צלילים כבויים 🔕', 'Sounds off 🔕')); if (soundOn()) play('turn'); render(); },
      }, soundOn() ? '🔔' : '🔕') : null),
    h('div', { class: 'players' }, tag(0), h('span', { class: 'vs' }, T('נגד', 'vs')), tag(1)));
}

/** guest: the name of whoever opened the page (from the game, or from the invite link) */
function guestHostName() {
  return (state && state.players[0].name) || (session && session.hostName) || inviterName();
}
/** link back to the same page, for the inviter (their phone still holds the room and simply reopens it) */
function roomLink() {
  const u = new URL(LANG === 'en' ? 'en/' : './', document.baseURI);
  u.searchParams.set('room', session.code);
  if (LOCAL) u.searchParams.set('local', 'host');
  u.searchParams.set('back', '1');
  return u.toString();
}
function nudgeText() {
  return T(`${myName()} כאן ✏️ פתחתי את דף ועיפרון ואני מחכה לך – בוא/י לשחק! `, `${myName()} here ✏️ I opened Paper & Pencil and I\'m waiting for you – come play! `) + roomLink();
}
let nudges = 0;
function nudgeTracked(method) {
  nudges++;
  track('host_nudged', { method, in_game: !!state, seconds_waiting: netT0 ? Math.round((Date.now() - netT0) / 1000) : null, nudge_n: nudges }, { now: true });
}
async function nudgeHost() {
  const text = nudgeText();
  if (navigator.share) {
    try { await navigator.share({ text }); nudgeTracked('native_share'); toast(T('נשלח ✓ ממשיכים לחכות כאן', 'Sent ✓ waiting here')); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  nudgeTracked('whatsapp');
  location.href = 'https://wa.me/?text=' + encodeURIComponent(text);
}

function connNote() {
  const joined = !!(state && state.players[1].token);
  const other = (state && state.players[1 - me].name) || (me === 0 ? T('השותף', 'your partner') : T('המארח', 'the host'));
  const code = session.code;
  let title, lines = [], busy = false, retry = false, nudge = false;
  if (link === 'offline') {
    title = T('אין אינטרנט בטלפון הזה', 'No internet on this phone');
    lines = [T('בדקו שה-WiFi או הגלישה פועלים.', 'Check that Wi-Fi or mobile data is on.'), T('ממשיכים לנסות לבד – אין צורך לרענן.', 'We keep trying by ourselves – no need to refresh.')];
    busy = true; retry = true;
  } else if (link === 'full') {
    title = T('בדף הזה כבר משחקים שניים', 'Two people are already playing on this page');
    lines = [T('החלפתם טלפון? אצל מי שפתח את הדף: בתפריט לוחצים "החלפת שותף", ואז כאן "לנסות שוב".', 'Changed phones? On the phone that opened the page, tap "Replace partner" in the menu, then tap "Try again" here.')];
    retry = true;
  } else if (me === 0) {
    title = joined ? T(`מחכים ש${other} יחזור/תחזור…`, `Waiting for ${other} to come back…`) : T('מחכים שמישהו יצטרף…', 'Waiting for someone to join…');
    lines = joined
      ? [T('המשחק שמור ולא הולך לאיבוד.', 'The game is saved and won\'t be lost.'), T(`אצל ${other}: פותחים שוב את המשחק (אותו קישור) והוא ממשיך מאותה נקודה.`, `${other} just needs to open the game again (same link) and it continues where you left off.`)]
      : [T(`הקוד של הדף: ${code}`, `Page code: ${code}`)];
    busy = true;
  } else if (link === 'no-host') {
    // the inviter is simply not there right now: let them know we arrived, they come back through the link
    const host = guestHostName();
    title = host ? T(`${host} לא בדף כרגע`, `${host} isn\'t on the page right now`) : T('מי שפתח/ה את הדף לא שם כרגע', 'The person who opened the page isn\'t there right now');
    lines = [
      T('אולי סגר/ה את המשחק. שלחו הודעה שהגעתם – וכשיפתח/תפתח את הקישור, תתחברו לבד.', 'Maybe they closed the game. Let them know you\'re here – when they open the link, you\'ll connect by yourselves.'),
      T(`אפשר לחכות כאן, או לסגור ולחזור אחר כך לאותו קישור. (קוד הדף: ${code})`, `You can wait here, or close and come back to the same link later. (Page code: ${code})`),
    ];
    busy = true; nudge = true;
  } else {
    title = state ? T(`החיבור ל${other} נפל – מתחברים מחדש…`, `Lost the connection to ${other} – reconnecting…`) : T(`מתחברים לדף ${code}…`, `Connecting to page ${code}…`);
    lines = [state ? T('המשחק שמור. אין צורך לעשות כלום.', 'The game is saved. Nothing to do.') : T('זה לוקח כמה שניות.', 'This takes a few seconds.')];
    busy = true;
  }
  return h('div', { class: 'note warn conn' },
    h('div', { class: 'conn-title' }, busy ? h('span', { class: 'spin' }) : '⚠️ ', title),
    lines.map(l => h('div', { class: 'conn-line' }, l)),
    nudge ? h('div', { class: 'row nudge-row' },
      h('button', { class: 'btn marker', 'data-log': 'nudge-host', onclick: () => nudgeHost('share') }, T(`📲 להגיד ל${guestHostName() || 'מי שהזמין'} שהגעתי`, `📲 Tell ${guestHostName() || 'them'} I\'m here`)),
      h('a', { class: 'btn small', 'data-log': 'nudge-whatsapp', href: 'https://wa.me/?text=' + encodeURIComponent(nudgeText()), target: '_blank', rel: 'noopener', onclick: () => nudgeTracked('whatsapp') }, T('וואטסאפ', 'WhatsApp'))) : null,
    h('div', { class: 'conn-actions' },
      retry || nudge ? h('button', { class: (nudge ? 'link-btn' : 'btn small marker'), 'data-log': 'retry', onclick: () => { net && net.wake(); toast(T('מנסה שוב…', 'Trying again…')); } }, T('לנסות שוב', 'Try again')) : null,
      h('button', { class: 'link-btn', 'data-log': 'leave', onclick: () => (state ? askLeaveRoom() : leaveRoom()) }, state ? T('יציאה מהדף', 'Leave the page') : T('ביטול', 'Cancel')),
      h('button', { class: 'link-btn', 'data-log': 'tech', onclick: showTech }, T('משהו לא עובד?', 'Something not working?'))));
}

/** "something is wrong" sheet: plain-language checklist + technical details + send a report */
function showTech() {
  if (techOpen) return;
  techOpen = true;
  const info = net ? net.info() : { channels: [], status: '-' };
  track('trouble_opened', { status: info.status, screen: lastView });
  const relays = info.channels.filter(c => c.name.startsWith('relay'));
  const up = relays.filter(c => c.open).length;
  const bg = h('div', { class: 'modal-bg' });
  const close = () => { techOpen = false; bg.remove(); };
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  bg.append(h('div', { class: 'modal card tech' },
    h('h3', {}, T('משהו לא עובד?', 'Something not working?')),
    h('ol', { class: 'help' },
      h('li', {}, T('שני הטלפונים צריכים להיות עם המשחק פתוח על המסך.', 'Both phones need the game open on the screen.')),
      h('li', {}, T('בודקים שיש אינטרנט בשניהם (אפשר לנסות לכבות ולהדליק WiFi).', 'Check that both have internet (try turning Wi-Fi off and on).')),
      h('li', {}, T('לוחצים "לנסות שוב", ואם לא עוזר – מרעננים את הדף. המשחק שמור.', 'Tap "Try again". If that doesn\'t help, refresh the page. The game is saved.'))),
    h('div', { class: 'tech-box' },
      h('div', {}, T(`מזהה מכשיר: `, `Device ID: `), h('b', {}, logDev), T(` · גרסה ${VERSION}`, ` · version ${VERSION}`)),
      h('div', {}, T(`מצב: ${info.status} · שרתי תיווך: ${up}/${relays.length}`, `Status: ${info.status} · relay servers: ${up}/${relays.length}`)),
      h('div', {}, info.channels.map(c => `${c.open ? '✓' : '✗'} ${c.name.replace('relay:', '')}`).join('  ')),
      h('div', {}, T(`אינטרנט: ${navigator.onLine ? 'יש' : 'אין'}`, `Internet: ${navigator.onLine ? 'yes' : 'no'}`))),
    h('div', { class: 'row center' },
      h('button', {
        class: 'btn marker small', 'data-log': 'send-report', onclick: async e => {
          e.target.disabled = true;
          log('report', net ? net.info() : null, true);
          track('problem_reported', { status: net ? net.info().status : '-', screen: lastView, log_device: logDev }, { now: true });
          const ok = await flushLog(true);
          toast(ok ? T(`הדיווח נשלח ✓ (מזהה ${logDev})`, `Report sent ✓ (ID ${logDev})`) : T('לא הצלחתי לשלוח – אין אינטרנט?', 'Could not send – no internet?'));
          e.target.disabled = false;
        },
      }, T('שליחת דיווח תקלה', 'Send a problem report')),
      h('button', { class: 'btn ghost small', onclick: close }, T('סגירה', 'Close'))),
    h('pre', { class: 'tech-log' }, logRing.slice(-14).join('\n'))));
  document.body.append(bg);
}

async function askLeaveRoom() {
  if (await confirmBox(T('לצאת מהדף הזה? (אפשר לחזור עם הקוד)', 'Leave this page? (you can come back with the code)'), T('יציאה', 'Leave'), T('ביטול', 'Cancel'))) leaveRoom();
}

async function leaveGame() {
  if (state.game && !state.game.over) {
    const yes = await confirmBox(T('לעצור ולחזור לטבלה? המשחק הזה יתחיל אחר כך מההתחלה.', 'Stop and go back to the table? This game will start over next time.'), T('כן, לטבלה', 'Yes, to the table'), T('להמשיך לשחק', 'Keep playing'));
    track('leave_game_prompt', { game: state.current, confirmed: yes });
    if (!yes) return;
  }
  act({ k: 'menu' });
}

async function askNewSeries() {
  const mid = state.series.results.length > 0 && !seriesDone(state) && seriesDecided(state) == null;
  if (mid && !await confirmBox(T('להתחיל סדרה חדשה? הסדרה הנוכחית תיסגר בלי מנצח.', 'Start a new series? The current one will close with no winner.'), T('כן, סדרה חדשה', 'Yes, new series'), T('ביטול', 'Cancel'))) return;
  act({ k: 'newSeries' });
}

async function askReplay() {
  const G = BY[state.current];
  const yes = await confirmBox(T(`לשחק שוב את "${G.title}"? התוצאה של המשחק הזה תימחק.`, `Play "${G.title}" again? The result of this game will be erased.`), T('כן, משחק חוזר', 'Yes, rematch'), T('ביטול', 'Cancel'));
  track('rematch_prompt', { game: G.id, confirmed: yes });
  if (yes) act({ k: 'replay' });
}

/** "אבא 2 : 1 נועה" in the two pen colours */
function seriesLine(ctx, big) {
  const w = seriesWins(state);
  return h('div', { class: 'series-line' + (big ? ' big' : '') },
    h('b', { class: 'ink0' }, ctx.names[0]), h('span', { class: 'sc' }, h('b', { class: 'ink0' }, w[0]), h('span', {}, ':'), h('b', { class: 'ink1' }, w[1])), h('b', { class: 'ink1' }, ctx.names[1]),
    w[2] ? h('small', { class: 'soft' }, T(` (תיקו: ${w[2]})`, ` (ties: ${w[2]})`)) : null);
}

/** the headline of a series that is decided / finished, or null */
function seriesVerdict(ctx) {
  const dec = seriesDecided(state), done = seriesDone(state);
  if (dec == null && !done) return null;
  const w = dec != null ? dec : seriesLeader(state);
  if (w == null) return { text: T('הסדרה נגמרה בתיקו! 🤝', 'The series ended in a tie! 🤝'), color: 'var(--pencil)', done, w };
  const sw = seriesWins(state);
  const score = `${Math.max(sw[0], sw[1])}:${Math.min(sw[0], sw[1])}`;
  return { text: (w === me ? T(`ניצחת את הסדרה ${score}! 🏆`, `You won the series ${score}! 🏆`) : T(`${ctx.names[w]} ניצח/ה את הסדרה ${score}! 🏆`, `${ctx.names[w]} won the series ${score}! 🏆`)), color: `var(--ink${w})`, done, w };
}

function seriesButtons(inResult) {
  const done = seriesDone(state), dec = seriesDecided(state);
  const nx = nextGame(state);
  const out = [];
  if (done) out.push(h('button', { class: 'btn marker', 'data-log': 'new-series', onclick: askNewSeries }, T('סדרה חדשה ✏️', 'New series ✏️')));
  else {
    const played = state.series.results.length;
    const label = dec != null ? T(`ממשיכים בשביל הספורט: ${BY[nx].title} ←`, `Play on for fun: ${BY[nx].title} →`) : inResult ? T(`למשחק הבא: ${BY[nx].title} ←`, `Next game: ${BY[nx].title} →`) : T(`${played ? 'ממשיכים' : 'מתחילים'}: ${BY[nx].title} ←`, `${played ? 'Continue' : 'Start'}: ${BY[nx].title} →`);
    out.push(h('button', { class: 'btn marker', 'data-log': 'next:' + nx, disabled: !state.players[1].token, onclick: () => act({ k: 'next' }) }, label));
    if (dec != null) out.push(h('button', { class: 'btn', 'data-log': 'new-series', onclick: askNewSeries }, T('סדרה חדשה', 'New series')));
  }
  return out;
}

function resultCard(G, ctx) {
  const w = state.game.over.winner;
  const title = w == null ? T('תיקו!', 'Tie!') : w === me ? T('ניצחת! 🏆', 'You won! 🏆') : T(`נקודה ל${ctx.names[w]}`, `A point for ${ctx.names[w]}`);
  const color = w == null ? 'var(--pencil)' : `var(--ink${w})`;
  const detail = G.overDetail ? G.overDetail(state.game, ctx) : null;
  const inSeries = state.game.sidx >= 0;
  const verdict = inSeries ? seriesVerdict(ctx) : null;
  const canReplay = inSeries && state.game.sidx === state.series.results.length - 1;
  return h('div', { class: 'card result' },
    h('div', { class: 'stamp', style: { color } }, title),
    detail ? h('p', {}, detail) : null,
    inSeries ? seriesLine(ctx) : null,
    verdict ? h('div', { class: 'verdict', style: { color: verdict.color } }, verdict.text) : null,
    verdict && !verdict.done ? h('p', { class: 'soft', style: { margin: '2px 0 8px' } }, T('רוצים להמשיך עד הסוף בשביל הספורט?', 'Want to play on to the end, just for fun?')) : null,
    h('div', { class: 'row center' }, inSeries ? seriesButtons(true) : null),
    h('div', { class: 'row center', style: { marginTop: '6px' } },
      canReplay ? h('button', { class: 'btn ghost small', 'data-log': 'replay', onclick: askReplay }, T('↺ משחק חוזר', '↺ Rematch')) : null,
      h('button', { class: 'btn ghost small', 'data-log': 'to-table', onclick: () => act({ k: 'menu' }) }, T('לטבלה', 'To the table'))));
}

const TOGETHER = T('הכי כיף כשיושבים אחד ליד השני – או מדברים בטלפון (על רמקול) תוך כדי המשחק. חצי מהכיף זה הדיבורים 🙂', 'It\'s most fun sitting next to each other – or talking on the phone (on speaker) while you play. Half the fun is the chatting 🙂');

function shareUrl() {
  // an English phone sends the English address, so the friend's link preview is in English too (en/index.html)
  const u = new URL(LANG === 'en' ? 'en/' : './', document.baseURI);
  u.searchParams.set('room', session.code);
  if (LOCAL) u.searchParams.set('local', 'guest');
  const src = campaignSource(); // analytics: a friend invited by a campaign player still counts for the campaign
  if (src) u.searchParams.set('src', src);
  // who invites: the friend trusts a name they know more than a site they do not (never sent to analytics)
  if (myName()) u.searchParams.set('from', myName());
  return u.toString();
}

function myName() { return (state && state.players[me].name) || (session && session.name) || ''; }

async function shareInvite(from) {
  const url = shareUrl();
  const text = T(`${myName()} מזמין/ה אותך לשחק איתי דף ועיפרון ✏️ 5 משחקים לשניים, בחינם ובלי הרשמה. (ותתקשר/י אליי – נדבר תוך כדי!) קוד: ${session.code}`, `${myName()} invites you to play Paper & Pencil ✏️ 5 games for two, free, no sign-up. (Call me – we\'ll talk while we play!) Code: ${session.code}`);
  const where = typeof from === 'string' ? from : 'invite_card';
  if (navigator.share) {
    try { await navigator.share({ title: T('דף ועיפרון', 'Paper & Pencil'), text, url }); track('invite_shared', { method: 'native_share', from: where }); return; } catch (e) {
      if (e && e.name === 'AbortError') { track('invite_share_cancelled', { from: where }); return; }
    }
  }
  try { await navigator.clipboard.writeText(url); toast(T('הקישור הועתק 📋', 'Link copied 📋')); track('invite_shared', { method: 'copy_link', from: where }); } catch { prompt(T('העתיקו את הקישור:', 'Copy the link:'), url); track('invite_shared', { method: 'manual_copy', from: where }); }
}

function inviteCard() {
  const url = shareUrl();
  const offline = link === 'offline';
  return h('div', { class: 'card center' },
    h('h3', {}, T('מזמינים שותף לדף', 'Invite a partner')),
    h('div', {}, T('הקוד של הדף:', 'Page code:')),
    h('div', { class: 'code-big' }, session.code),
    h('ol', { class: 'help' },
      h('li', {}, T('שולחים הזמנה לטלפון השני (כפתור למטה).', 'Send an invite to the other phone (button below).')),
      h('li', {}, T('בטלפון השני פותחים את הקישור וכותבים שם.', 'On the other phone, open the link and type a name.')),
      h('li', {}, h('b', {}, T('חוזרים לכאן ומחכים', 'Come back here and wait')), T(' – או סוגרים: כשהחבר/ה ייכנס/תיכנס, תקבלו ממנו/ה הודעה עם קישור לכאן.', ' – or close it: when your friend gets in, they can send you a message with a link back here.'))),
    h('div', { class: 'note tip' }, T('📞 לא באותו חדר? תתקשרו אחד לשני ושימו על רמקול – ככה זה מרגיש כמו פעם.', '📞 Not in the same room? Call each other and put it on speaker – it feels just like the old days.')),
    h('div', { class: 'row center' },
      h('button', { class: 'btn marker', 'data-log': 'share', onclick: shareInvite }, T('📤 שליחת הזמנה', '📤 Send invite')),
      h('a', { class: 'btn', 'data-log': 'whatsapp', href: 'https://wa.me/?text=' + encodeURIComponent(T(`${myName()} מזמין/ה אותך לשחק דף ועיפרון ✏️ 5 משחקים לשניים, בחינם ובלי הרשמה. תתקשר/י אליי ונדבר תוך כדי 📞 `, `${myName()} invites you to play Paper & Pencil ✏️ 5 games for two, free, no sign-up. Call me and we\'ll talk while we play 📞 `) + url), target: '_blank', rel: 'noopener', onclick: () => track('invite_shared', { method: 'whatsapp', from: 'invite_card' }, { now: true }) }, T('וואטסאפ', 'WhatsApp'))),
    h('div', { class: 'wait-line' + (offline ? ' bad' : '') },
      offline ? T('⚠️ אין אינטרנט בטלפון הזה – בדקו WiFi / גלישה', '⚠️ No internet on this phone – check Wi-Fi / mobile data') : [h('span', { class: 'spin' }), T('מחכים שמישהו יצטרף…', 'Waiting for someone to join…')]),
    h('button', { class: 'link-btn', 'data-log': 'tech', onclick: showTech }, T('משהו לא עובד?', 'Something not working?')));
}

function menuView(ctx) {
  const joined = !!state.players[1].token;
  const wrap = h('div', { class: 'menu' });
  if (!joined) wrap.append(me === 0 ? inviteCard() : connNote());
  else if (link !== 'linked') wrap.append(connNote());

  const res = state.series.results;
  const done = seriesDone(state);
  const verdict = seriesVerdict(ctx);
  wrap.append(
    h('h1', { class: 'title' }, T(`סדרה ${state.series.n}`, `Series ${state.series.n}`)),
    h('div', { class: 'center soft', style: { marginTop: '-4px' } }, T('הטוב מחמישה · משחקים לפי הסדר', 'Best of five · played in order')));

  GAMES.forEach((G, i) => {
    const r = res[i];
    const isNext = !done && i === res.length;
    let mark;
    if (r) mark = r.winner == null ? h('span', { class: 'soft' }, T('תיקו', 'Tie')) : h('b', { class: 'ink' + r.winner }, '✓ ' + ctx.names[r.winner]);
    else if (isNext) mark = h('span', { class: 'next-arrow' }, joined ? T('עכשיו ←', 'Now →') : '');
    else mark = h('span', { class: 'soft' }, '·');
    wrap.append(h('div', { class: 'game-row' + (r ? ' done' : isNext && joined ? ' next' : ' later') },
      h('span', { class: 'num' }, i + 1),
      h('span', {}, h('b', {}, G.title), h('small', {}, G.sub)),
      h('span', { class: 'row-mark' }, mark)));
  });

  if ((res.length || state.evening.some(x => x > 0)) && !installClosed) {
    const card = installCard('menu', () => { installClosed = true; render(); });
    if (card) wrap.append(card);
  }
  wrap.append(seriesLine(ctx, true));
  if (verdict) wrap.append(h('div', { class: 'verdict center', style: { color: verdict.color } }, verdict.text));
  if (verdict && !verdict.done) wrap.append(h('p', { class: 'center soft', style: { margin: '2px 0' } }, T('רוצים להמשיך עד הסוף בשביל הספורט?', 'Want to play on to the end, just for fun?')));
  if (joined) wrap.append(h('div', { class: 'row center mt' }, seriesButtons(false)));
  if (!res.length) wrap.append(h('div', { class: 'note tip' }, '💡 ', TOGETHER));

  const ev = state.evening;
  if (ev[0] + ev[1] + ev[2] > 0) {
    wrap.append(h('div', { class: 'card evening' },
      h('b', {}, T('סדרות הערב', 'Tonight\'s series')),
      [0, 1].map(p => h('div', { class: 'ev-row ink' + p }, h('span', {}, ctx.names[p]), tally(ev[p], p))),
      ev[2] ? h('div', { class: 'soft' }, T(`סדרות בתיקו: ${ev[2]}`, `Tied series: ${ev[2]}`)) : null));
  }

  const foot = h('div', { class: 'menu-foot' });
  if (joined && !done) foot.append(h('button', { class: 'link-btn', 'data-log': 'new-series', onclick: askNewSeries }, T('סדרה חדשה', 'New series')));
  if (me === 0 && joined) foot.append(h('button', { class: 'link-btn', 'data-log': 'code', onclick: () => shareInvite('menu_code') }, T(`קוד הדף: ${session.code}`, `Page code: ${session.code}`)));
  if (ev[0] + ev[1] + ev[2] > 0) foot.append(h('button', {
    class: 'link-btn', 'data-log': 'reset-evening', onclick: async () => {
      if (await confirmBox(T('למחוק את כל הניקוד של הערב ולהתחיל מאפס?', 'Erase all of tonight\'s scores and start from zero?'), T('כן, מאפס', 'Yes, start over'), T('ביטול', 'Cancel'))) act({ k: 'resetEvening' }); // tracked as evening_reset
    },
  }, T('איפוס הערב', 'Reset tonight')));
  if (me === 0 && joined) foot.append(h('button', {
    class: 'link-btn', 'data-log': 'replace-partner', onclick: async () => {
      if (!await confirmBox(T('לאפשר לטלפון אחר להצטרף במקום השותף הנוכחי?', 'Let another phone join instead of your current partner?'), T('כן', 'Yes'), T('ביטול', 'Cancel'))) return;
      const s = structuredClone(state);
      // the phone that is being replaced may not grab the seat back
      s.banned = [...(s.banned || []), s.players[1].token].filter(Boolean).slice(-6);
      s.players[1].token = null;
      commit(s);
      track('partner_replaced', { room_id: s.sid, series_n: s.series.n });
      toast(T('עכשיו טלפון אחר יכול להצטרף עם הקוד ', 'Another phone can now join with the code ') + session.code);
    },
  }, T('החלפת שותף', 'Replace partner')));
  foot.append(h('button', { class: 'link-btn', 'data-log': 'leave', onclick: askLeaveRoom }, T('יציאה מהדף', 'Leave the page')));
  foot.append(h('button', { class: 'link-btn', 'data-log': 'tech', onclick: showTech }, T('משהו לא עובד?', 'Something not working?')));
  wrap.append(foot);
  return wrap;
}

function renderConnecting() {
  app.replaceChildren(
    h('header', { class: 'top' }, h('div', { class: 'logo' }, T('דף ועיפרון', 'Paper & Pencil'))),
    connNote());
}

/* ======================= chat ("passing notes") ======================= */

const QUICK = ['😂', '👏', T('חחח', 'LOL'), T('כל הכבוד!', 'Well done!'), T('לא הוגן!! 😤', 'Not fair!! 😤'), T('רגע, חושב…', 'Wait, thinking…'), T('קדימה, תורך!', 'Come on, your turn!'), T('משחק חוזר?', 'Rematch?'), T('תתקשר אליי 📞', 'Call me 📞'), '❤️'];
let sheetEl = null;

// the chat button lives in the top bar (a floating button used to cover keys on small phones)
function ensureChatFab() { /* kept for callers: the header is re-rendered instead */ }

function openChat() {
  if (chatOpen) return;
  chatOpen = true; unread = 0;
  render();
  const bg = h('div', { class: 'sheet-bg', onclick: closeChat });
  const input = h('input', { class: 'paper', placeholder: T('לכתוב פתק…', 'Write a note…'), maxlength: 240, enterkeyhint: 'send' });
  const send = (text, quick) => {
    if (!text.trim()) return;
    act({ k: 'chat', text });
    // never the text itself: only whether it was a ready-made note (those are ours) and how long a typed one was
    track('note_sent', quick ? { kind: 'quick', quick: text } : { kind: 'typed', length: text.trim().length < 15 ? 'short' : text.trim().length < 60 ? 'medium' : 'long' }, undefined);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { send(input.value); input.value = ''; } });
  sheetEl = h('div', { class: 'sheet' },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('h3', {}, T('פתקים', 'Notes')),
      h('button', { class: 'icon-btn', onclick: closeChat }, '✕')),
    h('div', { class: 'msgs' }),
    h('div', { class: 'quick' }, QUICK.map(q => h('button', { onclick: () => send(q, true) }, q))),
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
      input,
      h('button', { class: 'btn small marker', onclick: () => { send(input.value); input.value = ''; input.focus(); } }, T('שלח', 'Send'))));
  sheetEl._bg = bg;
  document.body.append(bg, sheetEl);
  renderChat();
}

function closeChat() {
  chatOpen = false;
  if (sheetEl) { sheetEl._bg.remove(); sheetEl.remove(); sheetEl = null; }
}

function renderChat() {
  if (!sheetEl || !state) return;
  const box = sheetEl.querySelector('.msgs');
  box.replaceChildren(...(state.chat.length ? state.chat.map(m =>
    h('div', { class: 'msg ' + (m.p === me ? 'mine' : 'theirs'), style: { color: `var(--ink${m.p})` } },
      h('b', {}, state.players[m.p].name), m.text))
    : [h('p', { class: 'soft center' }, T('עוד אין פתקים. אפשר לכתוב משהו מצחיק 🙂', 'No notes yet. Write something funny 🙂'))]));
  box.scrollTop = box.scrollHeight;
}

/* ======================= home / join ======================= */

/** what a careful first-time visitor wants to know */
const trustLine = () => h('div', { class: 'trust' }, T('בחינם · בלי הרשמה · בלי הורדה · בלי פרסומות', 'Free · no sign-up · no download · no ads'));

/** the name in an invite link (?from=…), shown as text only */
function inviterName() { return (params.get('from') || '').replace(/[<>]/g, '').trim().slice(0, 14); }

/** a visitor who came from a paid ad (not from a friend's invite) */
function fromAd() {
  const m = (params.get('utm_medium') || '').toLowerCase();
  return /^(paid|cpc|ppc|ad|ads|paid_social|social_paid)$/.test(m) || params.has('ttclid') || params.has('fbclid');
}

function homeView(room, opts = {}) {
  const from = room ? inviterName() : '';
  const landing = !room && (opts.landing || fromAd());
  const nameIn = h('input', { class: 'paper', placeholder: T('השם שלי', 'My name'), maxlength: 14, value: store.get('name', '') });
  const codeIn = h('input', { class: 'paper code', placeholder: '____', inputmode: 'numeric', maxlength: 4, value: room || '' });
  const getName = () => {
    const n = nameIn.value.trim();
    if (!n) { toast(T('קודם כותבים שם 🙂', 'Type your name first 🙂')); nameIn.focus(); track('name_missing', { screen: room ? 'join' : 'home' }); return null; }
    store.set('name', n);
    return cleanName(n);
  };
  const join = via => {
    const n = getName(); if (!n) return;
    const code = codeIn.value.replace(/\D/g, '');
    if (code.length !== 4) { toast(T('הקוד הוא 4 ספרות', 'The code is 4 digits')); codeIn.focus(); track('join_code_invalid', { length: code.length }); return; }
    startGuest(n, code, via === 'invite_link' ? 'invite_link' : 'typed_code');
  };
  const doodle = h('div', { class: 'center', style: { fontSize: '15px', margin: '4px 0 6px' }, html:
    T('בול פגיעה · איש תלוי · צוללות · נקודות · 5 בשורה', 'Bulls & Cows · Hangman · Battleships · Dots & Boxes · Five in a Row') });
  const other = LANG === 'he' ? 'en' : 'he';
  const kids = [
    h('div', { class: 'lang-switch' }, h('button', {
      class: 'link-btn', 'data-log': 'lang-' + other, lang: other,
      onclick: async () => { track('language_switched', { from: LANG, to: other, screen: room ? 'join' : 'home' }, { now: true }); await flushAnalytics(true); setLang(other); },
    }, other === 'en' ? 'English' : 'עברית')),
    h('h1', { class: 'center', style: { fontSize: '64px', marginTop: '22px' } }, T('דף ועיפרון', 'Paper & Pencil')),
    doodle,
    landing
      ? h('p', { class: 'center landing-pitch' }, T('שולחים לחבר/ה קישור, וכל אחד משחק מהטלפון שלו – כמו פעם עם דף ועיפרון ✏️', 'Send a friend a link and each of you plays on your own phone – just like paper and pencil ✏️'))
      : h('p', { class: 'center soft' }, T('כל אחד עם הטלפון שלו – כמו הדף שהיה לכל אחד מול העיניים.', 'Each on your own phone – just like each of you had your own sheet of paper.')),
    landing ? null : h('div', { class: 'note tip' }, '💡 ', TOGETHER),
    h('div', { class: 'card stack' }, h('label', {}, T('איך קוראים לך?', 'What\'s your name?')), nameIn),
  ];
  if (room) {
    kids.push(h('div', { class: 'card stack center' },
      h('h3', {}, from ? T(`${from} מזמין/ה אותך לשחק! 🎉`, `${from} invited you to play! 🎉`) : T('הוזמנת לשחק!', 'You\'re invited to play!')),
      h('div', {}, T('קוד הדף', 'Page code')), h('div', { class: 'code-big' }, room),
      h('button', { class: 'btn big marker', onclick: () => { codeIn.value = room; join('invite_link'); } }, T('הצטרפות ✏️', 'Join ✏️')),
      trustLine()));
  } else {
    kids.push(
      landing
        // straight from an ad: the whole point is the friend, so inviting is the first thing
        ? h('button', { class: 'btn big marker mt', 'data-log': 'landing-invite', onclick: () => { const n = getName(); if (n) { startHost(n); shareInvite('landing'); } } }, T('📤 מזמינים חבר/ה לשחק', '📤 Invite a friend to play'))
        : h('button', { class: 'btn big marker mt', onclick: () => { const n = getName(); if (n) startHost(n); } }, T('📄 פותחים דף חדש', '📄 Start a new page')),
      trustLine(),
      h('p', { class: 'center soft' }, T('— או —', '— or —')),
      h('div', { class: 'card stack' }, h('label', {}, T('יש לי קוד מהטלפון השני:', 'I have a code from the other phone:')), codeIn,
        h('button', { class: 'btn', onclick: () => join('typed_code') }, T('הצטרפות', 'Join'))));
  }
  kids.push(
    room ? null : h('div', { class: 'card' },
      h('b', {}, T('איך זה עובד?', 'How does it work?')),
      h('ol', { class: 'help' },
        h('li', {}, T('אחד פותח דף חדש ומקבל קוד של 4 ספרות.', 'One of you starts a new page and gets a 4-digit code.')),
        h('li', {}, T('השני מצטרף עם הקישור או עם הקוד.', 'The other joins with the link or the code.')),
        h('li', {}, T('משחקים סדרה של חמישה משחקים – הטוב מחמישה מנצח.', 'Play a series of five games – best of five wins.')))),
    room ? null : h('div', { class: 'center' }, installLink('home')),
    h('p', { class: 'center soft', style: { fontSize: '12px' } }, T(`גרסה ${VERSION} · האתר שולח נתוני שימוש ונתוני חיבור אנונימיים כדי לשפר את המשחקים ולאתר תקלות (בלי שמות ובלי תוכן המשחק).`, `Version ${VERSION} · The site sends anonymous usage and connection data to improve the games and find problems (no names, no game content).`)));
  viewIs(room ? 'join' : landing ? 'landing' : 'home');
  app.replaceChildren(...kids.filter(Boolean));
}

function deviceToken() {
  let t = store.get('token', null);
  if (!t) { t = rid(12); store.set('token', t); }
  return t;
}

function startHost(name) {
  const code = newCode();
  session = { role: 'host', code, token: deviceToken(), name, fresh: true, created: Date.now() };
  store.set('session', session);
  state = newState(name, session.token);
  store.set('state:' + code, state);
  history.replaceState(null, '', location.pathname + (LOCAL ? location.search : ''));
  const n = bump('rooms_hosted');
  track('room_created', { room_id: state.sid, is_first_room: n === 1 }, { now: true, set: lifetime(), setOnce: { first_role: 'host' } });
  startNet();
  onState();
}

function startGuest(name, code, via) {
  session = { role: 'guest', code, token: deviceToken(), name, justJoined: true, hostName: inviterName() || null };
  const n = bump('rooms_joined');
  track('join_submitted', { via: via || 'typed_code', is_first_join: n === 1 }, { now: true, set: lifetime(), setOnce: { first_role: 'guest' } });
  store.set('session', session);
  store.del('gstate:' + code); // a fresh join never trusts an old copy of some other evening
  state = null;
  startNet();
  state ? onState() : render();
}

function leaveRoom() {
  if (state) track('room_left', { room_id: state.sid, in_game: !!(state.game && !state.game.over), series_n: state.series.n, games_in_series: state.series.results.length, partner_joined: !!state.players[1].token, minutes_in_room: session && session.created ? Math.round((Date.now() - session.created) / 60000) : null }, { now: true });
  setContext({ role: null });
  seenState = null;
  net && net.destroy(); net = null;
  clearInterval(outboxTimer); outbox = [];
  store.del('session');
  session = null; state = null; seenChat = null; prevGameKey = null; link = 'waiting';
  setLogContext('');
  closeChat();
  closeHelp();
  applyTurnLook({ mine: false, holder: null, st: null });
  const u = new URL(location.href);
  u.searchParams.delete('room');
  history.replaceState(null, '', u.pathname + u.search);
  homeView(null);
}

/* ======================= keep the screen awake ======================= */

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not allowed */ }
}
document.addEventListener('pointerdown', keepAwake, { capture: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { keepAwake(); net && net.wake(); }
});

/* ======================= boot ======================= */

/** index.html and the scripts must come from the same release (a browser can hold a mix right after an update) */
function mixedVersions() {
  if (!window.__dvV || window.__dvV === VERSION) return false;
  log('mixed-versions', `page ${window.__dvV} scripts ${VERSION}`, true);
  let tried = false;
  try { tried = sessionStorage.getItem('dv:mixfix') === VERSION; sessionStorage.setItem('dv:mixfix', VERSION); } catch { /* ignore */ }
  if (tried) return false;
  const u = new URL(location.href);
  u.searchParams.set('r', Date.now().toString(36)); // a fresh address makes the browser fetch a fresh page
  location.replace(u.toString());
  return true;
}

/** a saved/received state this version can work with */
function validState(s) {
  return !!(s && s.v === STATE_V && s.series && Array.isArray(s.series.results) && Array.isArray(s.players) && s.players.length === 2 && Array.isArray(s.evening) && Array.isArray(s.chat));
}

async function boot() {
  if (mixedVersions()) return;
  if (!DEMO) registerServiceWorker();
  if (DEMO) {
    const { demoState } = await import('./demo.js');
    me = params.get('me') === '1' ? 1 : 0;
    session = { role: me === 0 ? 'host' : 'guest', code: '4821', token: 't' + me, name: 'demo' };
    const d = demoState(params.get('demo'));
    if (d.home) { session = null; homeView(d.room || null, { landing: d.landing }); return; }
    state = d.state; link = d.link || 'linked';
    if (d.hostName) session.hostName = d.hostName;
    if (!state) { render(); return; }
    onState();
    return;
  }
  await claimPrimaryTab();
  session = store.get('session', null);
  const room = (params.get('room') || '').replace(/\D/g, '').slice(0, 4);
  const resumes = !!(session && (!room || room === session.code));
  setContext({ ui_lang: LANG, device_lang: (navigator.language || '').slice(0, 10) });
  if (resumes) setContext({ role: session.role });
  trackPageview(resumes ? 'resume' : room ? 'invite_link' : 'direct');
  if (session && (!room || room === session.code)) {
    if (session.role === 'host') {
      state = store.get('state:' + session.code, null) || newState(session.name, session.token);
      if (!validState(state)) {
        // saved by an older version of the site: keep the people, start the scoring fresh
        const old = state;
        state = newState(session.name, session.token);
        if (Array.isArray(old.players) && old.players.length === 2) state.players = old.players;
        state.sid = old.sid || state.sid; state.chat = Array.isArray(old.chat) ? old.chat : []; state.banned = old.banned;
        state.rev = (old.rev || 0) + 1;
      }
      if (!state.acks) state.acks = [];
      if (!state.sid) state.sid = rid(10);
      if (session.fresh) { session.fresh = false; store.set('session', session); }
    } else {
      state = store.get('gstate:' + session.code, null);
      // a copy saved by an older version of the site (e.g. before the best-of-five series) cannot be drawn:
      // drop it and take a fresh copy from the host instead of crashing on every load
      if (state && !validState(state)) { log('stale-gstate', state.v, true); track('stale_saved_game_dropped', { saved_v: state.v || 0 }); store.del('gstate:' + session.code); state = null; }
    }
    startNet();
    state ? onState() : render();
    return;
  }
  session = null;
  homeView(room || null);
}
// small handle for automated tests / debugging in the console
window.__dv = { get net() { return net; }, get state() { return state; }, get link() { return link; }, get session() { return session; }, get outbox() { return outbox; }, get log() { return logRing; }, act, flushAnalytics, get sounds() { return window.__dvSounds || []; } };
boot();

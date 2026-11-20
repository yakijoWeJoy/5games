import { h, toast, confirmBox, tally, buzz, rid } from './ui.js';
import { Link, LOCAL } from './net.js';
import { play, soundOn, setSound } from './sound.js';
import { log, flush as flushLog, setLogContext, dev as logDev, ring as logRing, VERSION } from './log.js';
import { track, trackPageview, trackScreen, setContext, bump, lifetime, flush as flushAnalytics } from './analytics.js';
import { gameEvents } from './metrics.js';
import { GAMES, BY, STATE_V, NEED, cleanName, newState, reduce, seriesWins, seriesDone, seriesDecided, seriesLeader, nextGame } from './core.js';

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
  if (link !== 'linked') { toast('אין חיבור כרגע… מנסה להתחבר שוב'); net && net.wake(); return; }
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
  if (dropped) toast('הפעולה האחרונה לא נשלחה – נסו שוב');
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
          toast(`${s.players[1].name} הצטרף/ה לדף! ✏️`); buzz([40, 60, 40]); play('join');
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
  toast(v > STATE_V ? 'צריך לרענן את הדף בטלפון הזה כדי לקבל את הגרסה החדשה' : 'בטלפון השני יש גרסה ישנה – צריך לרענן שם את הדף', null, 6000);
}

const newCode = () => {
  if (window.__dvForceCode) { const c = window.__dvForceCode; window.__dvForceCode = null; return c; } // test hook
  return String(Math.floor(1000 + Math.random() * 9000));
};

/* ======================= reacting to state ======================= */

function ctxFor() {
  const names = state.players.map((p, i) => p.name || (i === 0 ? 'מארח' : 'אורח'));
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
      if (!chatOpen) { unread++; toast(m.text, `✉️ פתק מ${state.players[m.p].name}`, 3800); }
    }
  }
  // game switched by the other player
  const key = state.game ? state.game.id : null;
  if (prevGameKey !== undefined && prevGameKey !== null && key === null && state.leftBy !== me) {
    toast(`${state.players[1 - me].name} חזר/ה לתפריט`);
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
  const want = ti.st && ti.mine ? '✏️ תורך! · דף ועיפרון' : 'דף ועיפרון';
  if (document.title !== want) document.title = want;
}

function turnBanner(G, ctx, ti) {
  const help = h('button', { class: 'help-btn', 'data-log': 'help', 'aria-label': 'איך משחקים?', title: 'איך משחקים?', onclick: () => showHelp(G, false) }, '?');
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
    h('div', { class: 'modal card help-card', role: 'dialog', 'aria-label': 'איך משחקים ' + G.title },
      h('h3', {}, `איך משחקים ${G.title}?`),
      h('ul', { class: 'help-list' }, (G.help || []).map(l => h('li', { html: l }))),
      h('button', { class: 'btn marker', 'data-log': 'help-ok', onclick: done }, 'הבנתי ✓'),
      auto ? h('div', { class: 'soft help-foot' }, 'אפשר לפתוח שוב בכל רגע עם ה-? למעלה') : null));
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
    p === holder ? h('span', { class: 'holder-ico', title: 'העיפרון אצל ' + (state.players[p].name || '') }, '✏️') : null,
    p !== me ? h('span', { class: 'dot' + (online ? ' on' : ''), title: online ? 'מחובר' : 'לא מחובר' }) : null,
    h('span', { class: 'pname' }, state.players[p].name || '…'),
    h('span', { class: 'ptot' }, total(p)));
  const joined = !!state.players[1].token;
  return h('header', { class: 'top' },
    h('div', { class: 'top-btns' },
      state.current
        ? h('button', { class: 'icon-btn', 'data-log': 'to-table', onclick: leaveGame }, '☰', h('span', { class: 'lbl' }, ' טבלה'))
        : h('div', { class: 'logo' }, 'דף ועיפרון'),
      joined ? h('button', { class: 'icon-btn chat-btn', 'data-log': 'chat', onclick: openChat }, '✉️', h('span', { class: 'lbl' }, ' פתק'), unread ? h('span', { class: 'badge' }, unread) : null) : null,
      joined ? h('button', {
        class: 'icon-btn sound-btn', 'data-log': soundOn() ? 'sound-off' : 'sound-on', 'aria-label': soundOn() ? 'השתקת צלילים' : 'הפעלת צלילים',
        onclick: () => { setSound(!soundOn()); track('sound_toggled', { on: soundOn() }); toast(soundOn() ? 'צלילים פועלים 🔔' : 'צלילים כבויים 🔕'); if (soundOn()) play('turn'); render(); },
      }, soundOn() ? '🔔' : '🔕') : null),
    h('div', { class: 'players' }, tag(0), h('span', { class: 'vs' }, 'נגד'), tag(1)));
}

function connNote() {
  const joined = !!(state && state.players[1].token);
  const other = (state && state.players[1 - me].name) || (me === 0 ? 'השותף' : 'המארח');
  const code = session.code;
  let title, lines = [], busy = false, retry = false;
  if (link === 'offline') {
    title = 'אין אינטרנט בטלפון הזה';
    lines = ['בדקו שה-WiFi או הגלישה פועלים.', 'ממשיכים לנסות לבד – אין צורך לרענן.'];
    busy = true; retry = true;
  } else if (link === 'full') {
    title = 'בדף הזה כבר משחקים שניים';
    lines = ['החלפתם טלפון? אצל מי שפתח את הדף: בתפריט לוחצים "החלפת שותף", ואז כאן "לנסות שוב".'];
    retry = true;
  } else if (me === 0) {
    title = joined ? `מחכים ש${other} יחזור/תחזור…` : 'מחכים שמישהו יצטרף…';
    lines = joined
      ? ['המשחק שמור ולא הולך לאיבוד.', `אצל ${other}: פותחים שוב את המשחק (אותו קישור) והוא ממשיך מאותה נקודה.`]
      : [`הקוד של הדף: ${code}`];
    busy = true;
  } else if (link === 'no-host') {
    title = `הדף של ${other} לא עונה`;
    lines = [`1. אצל ${other}: המשחק פתוח על המסך? (לא ברקע, לא נעול)`, `2. הקוד נכון? נכנסתם לדף ${code}`, '3. לשני הטלפונים יש אינטרנט?', 'ברגע שהדף השני יתעורר – מתחברים לבד.'];
    busy = true; retry = true;
  } else {
    title = state ? `החיבור ל${other} נפל – מתחברים מחדש…` : `מתחברים לדף ${code}…`;
    lines = [state ? 'המשחק שמור. אין צורך לעשות כלום.' : 'זה לוקח כמה שניות.'];
    busy = true;
  }
  return h('div', { class: 'note warn conn' },
    h('div', { class: 'conn-title' }, busy ? h('span', { class: 'spin' }) : '⚠️ ', title),
    lines.map(l => h('div', { class: 'conn-line' }, l)),
    h('div', { class: 'conn-actions' },
      retry ? h('button', { class: 'btn small marker', 'data-log': 'retry', onclick: () => { net && net.wake(); toast('מנסה שוב…'); } }, 'לנסות שוב') : null,
      h('button', { class: 'link-btn', 'data-log': 'leave', onclick: () => (state ? askLeaveRoom() : leaveRoom()) }, state ? 'יציאה מהדף' : 'ביטול'),
      h('button', { class: 'link-btn', 'data-log': 'tech', onclick: showTech }, 'משהו לא עובד?')));
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
    h('h3', {}, 'משהו לא עובד?'),
    h('ol', { class: 'help' },
      h('li', {}, 'שני הטלפונים צריכים להיות עם המשחק פתוח על המסך.'),
      h('li', {}, 'בודקים שיש אינטרנט בשניהם (אפשר לנסות לכבות ולהדליק WiFi).'),
      h('li', {}, 'לוחצים "לנסות שוב", ואם לא עוזר – מרעננים את הדף. המשחק שמור.')),
    h('div', { class: 'tech-box' },
      h('div', {}, `מזהה מכשיר: `, h('b', {}, logDev), ` · גרסה ${VERSION}`),
      h('div', {}, `מצב: ${info.status} · שרתי תיווך: ${up}/${relays.length}`),
      h('div', {}, info.channels.map(c => `${c.open ? '✓' : '✗'} ${c.name.replace('relay:', '')}`).join('  ')),
      h('div', {}, `אינטרנט: ${navigator.onLine ? 'יש' : 'אין'}`)),
    h('div', { class: 'row center' },
      h('button', {
        class: 'btn marker small', 'data-log': 'send-report', onclick: async e => {
          e.target.disabled = true;
          log('report', net ? net.info() : null, true);
          track('problem_reported', { status: net ? net.info().status : '-', screen: lastView, log_device: logDev }, { now: true });
          const ok = await flushLog(true);
          toast(ok ? `הדיווח נשלח ✓ (מזהה ${logDev})` : 'לא הצלחתי לשלוח – אין אינטרנט?');
          e.target.disabled = false;
        },
      }, 'שליחת דיווח תקלה'),
      h('button', { class: 'btn ghost small', onclick: close }, 'סגירה')),
    h('pre', { class: 'tech-log' }, logRing.slice(-14).join('\n'))));
  document.body.append(bg);
}

async function askLeaveRoom() {
  if (await confirmBox('לצאת מהדף הזה? (אפשר לחזור עם הקוד)', 'יציאה', 'ביטול')) leaveRoom();
}

async function leaveGame() {
  if (state.game && !state.game.over) {
    const yes = await confirmBox('לעצור ולחזור לטבלה? המשחק הזה יתחיל אחר כך מההתחלה.', 'כן, לטבלה', 'להמשיך לשחק');
    track('leave_game_prompt', { game: state.current, confirmed: yes });
    if (!yes) return;
  }
  act({ k: 'menu' });
}

async function askNewSeries() {
  const mid = state.series.results.length > 0 && !seriesDone(state) && seriesDecided(state) == null;
  if (mid && !await confirmBox('להתחיל סדרה חדשה? הסדרה הנוכחית תיסגר בלי מנצח.', 'כן, סדרה חדשה', 'ביטול')) return;
  act({ k: 'newSeries' });
}

async function askReplay() {
  const G = BY[state.current];
  const yes = await confirmBox(`לשחק שוב את "${G.title}"? התוצאה של המשחק הזה תימחק.`, 'כן, משחק חוזר', 'ביטול');
  track('rematch_prompt', { game: G.id, confirmed: yes });
  if (yes) act({ k: 'replay' });
}

/** "אבא 2 : 1 נועה" in the two pen colours */
function seriesLine(ctx, big) {
  const w = seriesWins(state);
  return h('div', { class: 'series-line' + (big ? ' big' : '') },
    h('b', { class: 'ink0' }, ctx.names[0]), h('span', { class: 'sc' }, h('b', { class: 'ink0' }, w[0]), h('span', {}, ':'), h('b', { class: 'ink1' }, w[1])), h('b', { class: 'ink1' }, ctx.names[1]),
    w[2] ? h('small', { class: 'soft' }, ` (תיקו: ${w[2]})`) : null);
}

/** the headline of a series that is decided / finished, or null */
function seriesVerdict(ctx) {
  const dec = seriesDecided(state), done = seriesDone(state);
  if (dec == null && !done) return null;
  const w = dec != null ? dec : seriesLeader(state);
  if (w == null) return { text: 'הסדרה נגמרה בתיקו! 🤝', color: 'var(--pencil)', done, w };
  const sw = seriesWins(state);
  const score = `${Math.max(sw[0], sw[1])}:${Math.min(sw[0], sw[1])}`;
  return { text: (w === me ? `ניצחת את הסדרה ${score}! 🏆` : `${ctx.names[w]} ניצח/ה את הסדרה ${score}! 🏆`), color: `var(--ink${w})`, done, w };
}

function seriesButtons(inResult) {
  const done = seriesDone(state), dec = seriesDecided(state);
  const nx = nextGame(state);
  const out = [];
  if (done) out.push(h('button', { class: 'btn marker', 'data-log': 'new-series', onclick: askNewSeries }, 'סדרה חדשה ✏️'));
  else {
    const played = state.series.results.length;
    const label = dec != null ? `ממשיכים בשביל הספורט: ${BY[nx].title} ←` : inResult ? `למשחק הבא: ${BY[nx].title} ←` : `${played ? 'ממשיכים' : 'מתחילים'}: ${BY[nx].title} ←`;
    out.push(h('button', { class: 'btn marker', 'data-log': 'next:' + nx, disabled: !state.players[1].token, onclick: () => act({ k: 'next' }) }, label));
    if (dec != null) out.push(h('button', { class: 'btn', 'data-log': 'new-series', onclick: askNewSeries }, 'סדרה חדשה'));
  }
  return out;
}

function resultCard(G, ctx) {
  const w = state.game.over.winner;
  const title = w == null ? 'תיקו!' : w === me ? 'ניצחת! 🏆' : `נקודה ל${ctx.names[w]}`;
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
    verdict && !verdict.done ? h('p', { class: 'soft', style: { margin: '2px 0 8px' } }, 'רוצים להמשיך עד הסוף בשביל הספורט?') : null,
    h('div', { class: 'row center' }, inSeries ? seriesButtons(true) : null),
    h('div', { class: 'row center', style: { marginTop: '6px' } },
      canReplay ? h('button', { class: 'btn ghost small', 'data-log': 'replay', onclick: askReplay }, '↺ משחק חוזר') : null,
      h('button', { class: 'btn ghost small', 'data-log': 'to-table', onclick: () => act({ k: 'menu' }) }, 'לטבלה')));
}

const TOGETHER = 'הכי כיף כשיושבים אחד ליד השני – או מדברים בטלפון (על רמקול) תוך כדי המשחק. חצי מהכיף זה הדיבורים 🙂';

function shareUrl() {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('room', session.code);
  if (LOCAL) u.searchParams.set('local', 'guest');
  return u.toString();
}

async function shareInvite(from) {
  const url = shareUrl();
  const text = `בוא/י לשחק איתי בדף ועיפרון ✏️ (ותתקשר/י אליי – נדבר תוך כדי!) קוד: ${session.code}`;
  const where = typeof from === 'string' ? from : 'invite_card';
  if (navigator.share) {
    try { await navigator.share({ title: 'דף ועיפרון', text, url }); track('invite_shared', { method: 'native_share', from: where }); return; } catch (e) {
      if (e && e.name === 'AbortError') { track('invite_share_cancelled', { from: where }); return; }
    }
  }
  try { await navigator.clipboard.writeText(url); toast('הקישור הועתק 📋'); track('invite_shared', { method: 'copy_link', from: where }); } catch { prompt('העתיקו את הקישור:', url); track('invite_shared', { method: 'manual_copy', from: where }); }
}

function inviteCard() {
  const url = shareUrl();
  const offline = link === 'offline';
  return h('div', { class: 'card center' },
    h('h3', {}, 'מזמינים שותף לדף'),
    h('div', {}, 'הקוד של הדף:'),
    h('div', { class: 'code-big' }, session.code),
    h('ol', { class: 'help' },
      h('li', {}, 'שולחים הזמנה לטלפון השני (כפתור למטה).'),
      h('li', {}, 'בטלפון השני פותחים את הקישור וכותבים שם.'),
      h('li', {}, h('b', {}, 'חוזרים לכאן'), ' – הדף הזה צריך להישאר פתוח על המסך.')),
    h('div', { class: 'note tip' }, '📞 לא באותו חדר? תתקשרו אחד לשני ושימו על רמקול – ככה זה מרגיש כמו פעם.'),
    h('div', { class: 'row center' },
      h('button', { class: 'btn marker', 'data-log': 'share', onclick: shareInvite }, '📤 שליחת הזמנה'),
      h('a', { class: 'btn', 'data-log': 'whatsapp', href: 'https://wa.me/?text=' + encodeURIComponent('בוא/י לשחק איתי בדף ועיפרון ✏️ תתקשר/י אליי ונדבר תוך כדי המשחק 📞 ' + url), target: '_blank', rel: 'noopener', onclick: () => track('invite_shared', { method: 'whatsapp', from: 'invite_card' }, { now: true }) }, 'וואטסאפ')),
    h('div', { class: 'wait-line' + (offline ? ' bad' : '') },
      offline ? '⚠️ אין אינטרנט בטלפון הזה – בדקו WiFi / גלישה' : [h('span', { class: 'spin' }), 'מחכים שמישהו יצטרף…']),
    h('button', { class: 'link-btn', 'data-log': 'tech', onclick: showTech }, 'משהו לא עובד?'));
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
    h('h1', { class: 'title' }, `סדרה ${state.series.n}`),
    h('div', { class: 'center soft', style: { marginTop: '-4px' } }, 'הטוב מחמישה · משחקים לפי הסדר'));

  GAMES.forEach((G, i) => {
    const r = res[i];
    const isNext = !done && i === res.length;
    let mark;
    if (r) mark = r.winner == null ? h('span', { class: 'soft' }, 'תיקו') : h('b', { class: 'ink' + r.winner }, '✓ ' + ctx.names[r.winner]);
    else if (isNext) mark = h('span', { class: 'next-arrow' }, joined ? 'עכשיו ←' : '');
    else mark = h('span', { class: 'soft' }, '·');
    wrap.append(h('div', { class: 'game-row' + (r ? ' done' : isNext && joined ? ' next' : ' later') },
      h('span', { class: 'num' }, i + 1),
      h('span', {}, h('b', {}, G.title), h('small', {}, G.sub)),
      h('span', { class: 'row-mark' }, mark)));
  });

  wrap.append(seriesLine(ctx, true));
  if (verdict) wrap.append(h('div', { class: 'verdict center', style: { color: verdict.color } }, verdict.text));
  if (verdict && !verdict.done) wrap.append(h('p', { class: 'center soft', style: { margin: '2px 0' } }, 'רוצים להמשיך עד הסוף בשביל הספורט?'));
  if (joined) wrap.append(h('div', { class: 'row center mt' }, seriesButtons(false)));
  if (!res.length) wrap.append(h('div', { class: 'note tip' }, '💡 ', TOGETHER));

  const ev = state.evening;
  if (ev[0] + ev[1] + ev[2] > 0) {
    wrap.append(h('div', { class: 'card evening' },
      h('b', {}, 'סדרות הערב'),
      [0, 1].map(p => h('div', { class: 'ev-row ink' + p }, h('span', {}, ctx.names[p]), tally(ev[p], p))),
      ev[2] ? h('div', { class: 'soft' }, `סדרות בתיקו: ${ev[2]}`) : null));
  }

  const foot = h('div', { class: 'menu-foot' });
  if (joined && !done) foot.append(h('button', { class: 'link-btn', 'data-log': 'new-series', onclick: askNewSeries }, 'סדרה חדשה'));
  if (me === 0 && joined) foot.append(h('button', { class: 'link-btn', 'data-log': 'code', onclick: () => shareInvite('menu_code') }, `קוד הדף: ${session.code}`));
  if (ev[0] + ev[1] + ev[2] > 0) foot.append(h('button', {
    class: 'link-btn', 'data-log': 'reset-evening', onclick: async () => {
      if (await confirmBox('למחוק את כל הניקוד של הערב ולהתחיל מאפס?', 'כן, מאפס', 'ביטול')) act({ k: 'resetEvening' }); // tracked as evening_reset
    },
  }, 'איפוס הערב'));
  if (me === 0 && joined) foot.append(h('button', {
    class: 'link-btn', 'data-log': 'replace-partner', onclick: async () => {
      if (!await confirmBox('לאפשר לטלפון אחר להצטרף במקום השותף הנוכחי?', 'כן', 'ביטול')) return;
      const s = structuredClone(state);
      // the phone that is being replaced may not grab the seat back
      s.banned = [...(s.banned || []), s.players[1].token].filter(Boolean).slice(-6);
      s.players[1].token = null;
      commit(s);
      track('partner_replaced', { room_id: s.sid, series_n: s.series.n });
      toast('עכשיו טלפון אחר יכול להצטרף עם הקוד ' + session.code);
    },
  }, 'החלפת שותף'));
  foot.append(h('button', { class: 'link-btn', 'data-log': 'leave', onclick: askLeaveRoom }, 'יציאה מהדף'));
  foot.append(h('button', { class: 'link-btn', 'data-log': 'tech', onclick: showTech }, 'משהו לא עובד?'));
  wrap.append(foot);
  return wrap;
}

function renderConnecting() {
  app.replaceChildren(
    h('header', { class: 'top' }, h('div', { class: 'logo' }, 'דף ועיפרון')),
    connNote());
}

/* ======================= chat ("passing notes") ======================= */

const QUICK = ['😂', '👏', 'חחח', 'כל הכבוד!', 'לא הוגן!! 😤', 'רגע, חושב…', 'קדימה, תורך!', 'משחק חוזר?', 'תתקשר אליי 📞', '❤️'];
let sheetEl = null;

// the chat button lives in the top bar (a floating button used to cover keys on small phones)
function ensureChatFab() { /* kept for callers: the header is re-rendered instead */ }

function openChat() {
  if (chatOpen) return;
  chatOpen = true; unread = 0;
  render();
  const bg = h('div', { class: 'sheet-bg', onclick: closeChat });
  const input = h('input', { class: 'paper', placeholder: 'לכתוב פתק…', maxlength: 240, enterkeyhint: 'send' });
  const send = (text, quick) => {
    if (!text.trim()) return;
    act({ k: 'chat', text });
    // never the text itself: only whether it was a ready-made note (those are ours) and how long a typed one was
    track('note_sent', quick ? { kind: 'quick', quick: text } : { kind: 'typed', length: text.trim().length < 15 ? 'short' : text.trim().length < 60 ? 'medium' : 'long' }, undefined);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { send(input.value); input.value = ''; } });
  sheetEl = h('div', { class: 'sheet' },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('h3', {}, 'פתקים'),
      h('button', { class: 'icon-btn', onclick: closeChat }, '✕')),
    h('div', { class: 'msgs' }),
    h('div', { class: 'quick' }, QUICK.map(q => h('button', { onclick: () => send(q, true) }, q))),
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
      input,
      h('button', { class: 'btn small marker', onclick: () => { send(input.value); input.value = ''; input.focus(); } }, 'שלח')));
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
    : [h('p', { class: 'soft center' }, 'עוד אין פתקים. אפשר לכתוב משהו מצחיק 🙂')]));
  box.scrollTop = box.scrollHeight;
}

/* ======================= home / join ======================= */

function homeView(room) {
  const nameIn = h('input', { class: 'paper', placeholder: 'השם שלי', maxlength: 14, value: store.get('name', '') });
  const codeIn = h('input', { class: 'paper code', placeholder: '____', inputmode: 'numeric', maxlength: 4, value: room || '' });
  const getName = () => {
    const n = nameIn.value.trim();
    if (!n) { toast('קודם כותבים שם 🙂'); nameIn.focus(); return null; }
    store.set('name', n);
    return cleanName(n);
  };
  const join = via => {
    const n = getName(); if (!n) return;
    const code = codeIn.value.replace(/\D/g, '');
    if (code.length !== 4) { toast('הקוד הוא 4 ספרות'); codeIn.focus(); track('join_code_invalid', { length: code.length }); return; }
    startGuest(n, code, via === 'invite_link' ? 'invite_link' : 'typed_code');
  };
  const doodle = h('div', { class: 'center', style: { fontSize: '15px', margin: '4px 0 6px' }, html:
    'בול פגיעה · איש תלוי · צוללות · נקודות · 5 בשורה' });
  const kids = [
    h('h1', { class: 'center', style: { fontSize: '64px', marginTop: '22px' } }, 'דף ועיפרון'),
    doodle,
    h('p', { class: 'center soft' }, 'כל אחד עם הטלפון שלו – כמו הדף שהיה לכל אחד מול העיניים.'),
    h('div', { class: 'note tip' }, '💡 ', TOGETHER),
    h('div', { class: 'card stack' }, h('label', {}, 'איך קוראים לך?'), nameIn),
  ];
  if (room) {
    kids.push(h('div', { class: 'card stack center' },
      h('h3', {}, 'הוזמנת לשחק!'),
      h('div', {}, 'קוד הדף'), h('div', { class: 'code-big' }, room),
      h('button', { class: 'btn big marker', onclick: () => { codeIn.value = room; join('invite_link'); } }, 'הצטרפות ✏️')));
  } else {
    kids.push(
      h('button', { class: 'btn big marker mt', onclick: () => { const n = getName(); if (n) startHost(n); } }, '📄 פותחים דף חדש'),
      h('p', { class: 'center soft' }, '— או —'),
      h('div', { class: 'card stack' }, h('label', {}, 'יש לי קוד מהטלפון השני:'), codeIn,
        h('button', { class: 'btn', onclick: () => join('typed_code') }, 'הצטרפות')));
  }
  kids.push(
    room ? null : h('div', { class: 'card' },
      h('b', {}, 'איך זה עובד?'),
      h('ol', { class: 'help' },
        h('li', {}, 'אחד פותח דף חדש ומקבל קוד של 4 ספרות.'),
        h('li', {}, 'השני מצטרף עם הקישור או עם הקוד.'),
        h('li', {}, 'משחקים סדרה של חמישה משחקים – הטוב מחמישה מנצח.'))),
    h('p', { class: 'center soft', style: { fontSize: '12px' } }, `גרסה ${VERSION} · האתר שולח נתוני שימוש ונתוני חיבור אנונימיים כדי לשפר את המשחקים ולאתר תקלות (בלי שמות ובלי תוכן המשחק).`));
  viewIs(room ? 'join' : 'home');
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
  session = { role: 'guest', code, token: deviceToken(), name, justJoined: true };
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

async function boot() {
  if (mixedVersions()) return;
  if (DEMO) {
    const { demoState } = await import('./demo.js');
    me = params.get('me') === '1' ? 1 : 0;
    session = { role: me === 0 ? 'host' : 'guest', code: '4821', token: 't' + me, name: 'demo' };
    const d = demoState(params.get('demo'));
    if (d.home) { session = null; homeView(d.room || null); return; }
    state = d.state; link = d.link || 'linked';
    onState();
    return;
  }
  await claimPrimaryTab();
  session = store.get('session', null);
  const room = (params.get('room') || '').replace(/\D/g, '').slice(0, 4);
  const resumes = !!(session && (!room || room === session.code));
  if (resumes) setContext({ role: session.role });
  trackPageview(resumes ? 'resume' : room ? 'invite_link' : 'direct');
  if (session && (!room || room === session.code)) {
    if (session.role === 'host') {
      state = store.get('state:' + session.code, null) || newState(session.name, session.token);
      if (state.v !== STATE_V) {
        // saved by an older version of the site: keep the people, start the scoring fresh
        const old = state;
        state = newState(session.name, session.token);
        state.players = old.players; state.sid = old.sid || state.sid; state.chat = old.chat || []; state.banned = old.banned;
        state.rev = (old.rev || 0) + 1;
      }
      if (!state.acks) state.acks = [];
      if (!state.sid) state.sid = rid(10);
      if (session.fresh) { session.fresh = false; store.set('session', session); }
    } else {
      state = store.get('gstate:' + session.code, null);
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

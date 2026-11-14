import { h, toast, confirmBox, tally, buzz, rid } from './ui.js';
import { Link, LOCAL } from './net.js';
import { log, flush as flushLog, setLogContext, dev as logDev, ring as logRing, VERSION } from './log.js';
import { GAMES, BY, cleanName, newState, reduce } from './core.js';

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
let lastView = null;
let techOpen = false;

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
  const ok = reduce(s, p, a);
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
  if (a.k === 'pick' || a.k === 'menu') return { ...a, from: gid };
  return a;
}

function act(a0) {
  const a = withContext(a0);
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
  const onStatus = st => {
    const was = link;
    link = st;
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
        if (first) { toast(`${s.players[1].name} הצטרף/ה לדף! ✏️`); buzz([40, 60, 40]); }
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
  // chat notifications
  if (seenChat === null) seenChat = new Set(state.chat.map(m => m.id));
  for (const m of state.chat) {
    if (seenChat.has(m.id)) continue;
    seenChat.add(m.id);
    if (m.p !== me) {
      buzz([30, 40, 30]);
      if (!chatOpen) { unread++; toast(m.text, `✉️ פתק מ${state.players[m.p].name}`, 3800); }
    }
  }
  // game switched by the other player
  const key = state.game ? state.game.id : null;
  if (prevGameKey !== undefined && prevGameKey !== null && key === null && state.leftBy !== me) {
    toast(`${state.players[1 - me].name} חזר/ה לתפריט`);
  }
  if (key !== prevGameKey && key) log('game-start', state.current);
  if (state.game && state.game.over && loggedOver !== key) { loggedOver = key; log('game-over', `${state.current} ${state.game.over.winner === null ? 'tie' : state.game.over.winner === me ? 'me' : 'other'}`); }
  prevGameKey = key;
  // my turn?
  let mine = false;
  if (state.game && !state.game.over) mine = BY[state.current].status(state.game, ctxFor()).mine;
  if (mine && prevMyTurn === false) buzz(60);
  prevMyTurn = mine;

  render();
  renderChat();
}

/* ======================= rendering ======================= */

function viewIs(v) { if (v !== lastView) { lastView = v; log('view', v); } }

function render() {
  if (!session) return;
  if (!state) { viewIs('connecting'); renderConnecting(); return; }
  viewIs(state.current && state.game ? (state.game.over ? 'over:' : 'game:') + state.current + (state.game.phase ? ':' + state.game.phase : '') : (state.players[1].token ? 'menu' : 'invite'));
  const ctx = ctxFor();
  const kids = [header(ctx)];
  let gameRoot = null, G = null;
  if (state.current && state.game) {
    G = BY[state.current];
    const st = G.status(state.game, ctx);
    if (link !== 'linked') kids.push(connNote());
    if (state.game.over) kids.push(resultCard(G, ctx));
    else kids.push(h('div', { class: 'turn' + (st.mine ? ' mine' : '') }, st.text));
    gameRoot = h('div', { class: 'game' });
    kids.push(gameRoot);
  } else {
    kids.push(menuView(ctx));
  }
  // keep the keyboard open if the player was typing while an update arrived
  const act0 = document.activeElement;
  const fk = act0 && app.contains(act0) && act0.dataset ? act0.dataset.fk : null;
  const sel = fk ? [act0.selectionStart, act0.selectionEnd] : null;
  app.replaceChildren(...kids);
  if (gameRoot) G.render(gameRoot, state.game, ctx);
  if (fk) {
    const el = app.querySelector(`[data-fk="${fk}"]`);
    if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(sel[0], sel[1]); } catch { /* ignore */ } }
  }
  ensureChatFab();
}

function header(ctx) {
  const total = p => Object.values(state.score).reduce((a, x) => a + x[p], 0);
  const online = link === 'linked';
  const tag = p => h('div', { class: `ptag p${p}${p === me ? ' me' : ''}` },
    p !== me ? h('span', { class: 'dot' + (online ? ' on' : ''), title: online ? 'מחובר' : 'לא מחובר' }) : null,
    h('span', { class: 'pname' }, state.players[p].name || '…'),
    h('span', { class: 'ptot' }, total(p)));
  return h('header', { class: 'top' },
    state.current
      ? h('button', { class: 'icon-btn', onclick: leaveGame }, '☰ תפריט')
      : h('div', { class: 'logo' }, 'דף ועיפרון'),
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
    if (!await confirmBox('לחזור לתפריט באמצע המשחק? (בלי ניקוד)', 'כן, לתפריט', 'להמשיך לשחק')) return;
  }
  act({ k: 'menu' });
}

function nextGameId(after) {
  const i = after ? GAMES.findIndex(G => G.id === after) : -1;
  return GAMES[(i + 1) % GAMES.length].id;
}

function resultCard(G, ctx) {
  const w = state.game.over.winner;
  const title = w == null ? 'תיקו!' : w === me ? 'ניצחת! 🏆' : `נקודה ל${ctx.names[w]}`;
  const color = w == null ? 'var(--pencil)' : `var(--ink${w})`;
  const detail = G.overDetail ? G.overDetail(state.game, ctx) : null;
  const next = nextGameId(state.current);
  return h('div', { class: 'card result' },
    h('div', { class: 'stamp', style: { color } }, title),
    detail ? h('p', {}, detail) : null,
    h('div', { class: 'row center' },
      h('button', { class: 'btn marker', onclick: () => act({ k: 'pick', game: next }) }, `למשחק הבא: ${BY[next].title} ←`),
      h('button', { class: 'btn', onclick: () => act({ k: 'pick', game: state.current }) }, 'עוד סיבוב'),
      h('button', { class: 'btn ghost small', onclick: () => act({ k: 'menu' }) }, 'לתפריט')));
}

function shareUrl() {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('room', session.code);
  if (LOCAL) u.searchParams.set('local', 'guest');
  return u.toString();
}

async function shareInvite() {
  const url = shareUrl();
  const text = `בוא/י לשחק איתי בדף ועיפרון ✏️ קוד: ${session.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'דף ועיפרון', text, url }); return; } catch { /* cancelled */ }
  }
  try { await navigator.clipboard.writeText(url); toast('הקישור הועתק 📋'); } catch { prompt('העתיקו את הקישור:', url); }
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
    h('div', { class: 'row center' },
      h('button', { class: 'btn marker', 'data-log': 'share', onclick: shareInvite }, '📤 שליחת הזמנה'),
      h('a', { class: 'btn', 'data-log': 'whatsapp', href: 'https://wa.me/?text=' + encodeURIComponent('בוא/י לשחק איתי בדף ועיפרון ✏️ ' + url), target: '_blank', rel: 'noopener' }, 'וואטסאפ')),
    h('div', { class: 'wait-line' + (offline ? ' bad' : '') },
      offline ? '⚠️ אין אינטרנט בטלפון הזה – בדקו WiFi / גלישה' : [h('span', { class: 'spin' }), 'מחכים שמישהו יצטרף…']),
    h('button', { class: 'link-btn', 'data-log': 'tech', onclick: showTech }, 'משהו לא עובד?'));
}

function menuView(ctx) {
  const joined = !!state.players[1].token;
  const wrap = h('div', { class: 'menu' });
  if (!joined) wrap.append(me === 0 ? inviteCard() : connNote());
  else if (link !== 'linked') wrap.append(connNote());

  wrap.append(h('h1', { class: 'title' }, 'הסדרה של הערב'));
  const next = nextGameId(state.lastDone);
  GAMES.forEach((G, i) => {
    const sc = state.score[G.id];
    wrap.append(h('button', {
      class: 'game-row' + (G.id === next && joined ? ' next' : ''),
      disabled: !joined,
      onclick: () => act({ k: 'pick', game: G.id }),
    },
      h('span', { class: 'num' }, i + 1),
      h('span', {}, h('b', {}, G.title), h('small', {}, G.sub)),
      h('span', { class: 'tallies' }, tally(sc[0], 0), tally(sc[1], 1))));
  });

  const ties = Object.values(state.score).reduce((a, x) => a + x[2], 0);
  const t0 = Object.values(state.score).reduce((a, x) => a + x[0], 0);
  const t1 = Object.values(state.score).reduce((a, x) => a + x[1], 0);
  wrap.append(h('p', { class: 'center mt' },
    h('b', { class: 'ink0' }, `${ctx.names[0]}: ${t0}`), '  ·  ',
    h('b', { class: 'ink1' }, `${ctx.names[1]}: ${t1}`),
    ties ? h('span', { class: 'soft' }, `  ·  תיקו: ${ties}`) : null));

  const foot = h('div', { class: 'menu-foot' });
  if (me === 0 && joined) foot.append(h('button', { class: 'link-btn', onclick: shareInvite }, `קוד הדף: ${session.code}`));
  foot.append(h('button', {
    class: 'link-btn', onclick: async () => {
      if (await confirmBox('למחוק את טבלת הניקוד של הערב ולהתחיל מאפס?', 'כן, דף חדש', 'ביטול')) act({ k: 'resetScores' });
    },
  }, 'איפוס ניקוד'));
  if (me === 0 && joined) foot.append(h('button', {
    class: 'link-btn', onclick: async () => {
      if (!await confirmBox('לאפשר לטלפון אחר להצטרף במקום השותף הנוכחי?', 'כן', 'ביטול')) return;
      const s = structuredClone(state);
      // the phone that is being replaced may not grab the seat back
      s.banned = [...(s.banned || []), s.players[1].token].filter(Boolean).slice(-6);
      s.players[1].token = null;
      commit(s);
      toast('עכשיו טלפון אחר יכול להצטרף עם הקוד ' + session.code);
    },
  }, 'החלפת שותף'));
  foot.append(h('button', { class: 'link-btn', onclick: askLeaveRoom }, 'יציאה מהדף'));
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

const QUICK = ['😂', '👏', 'חחח', 'כל הכבוד!', 'לא הוגן!! 😤', 'רגע, חושב…', 'קדימה, תורך!', 'עוד סיבוב?', '❤️'];
let fab = null, sheetEl = null;

function ensureChatFab() {
  if (!state || !state.players[1].token) { fab && fab.remove(); fab = null; return; }
  if (!fab) {
    fab = h('button', { class: 'fab', onclick: openChat });
    document.body.append(fab);
  }
  fab.replaceChildren(...['✏️ פתק', unread ? h('span', { class: 'badge' }, unread) : null].filter(Boolean));
}

function openChat() {
  chatOpen = true; unread = 0;
  ensureChatFab();
  const bg = h('div', { class: 'sheet-bg', onclick: closeChat });
  const input = h('input', { class: 'paper', placeholder: 'לכתוב פתק…', maxlength: 240, enterkeyhint: 'send' });
  const send = text => { if (text.trim()) act({ k: 'chat', text }); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { send(input.value); input.value = ''; } });
  sheetEl = h('div', { class: 'sheet' },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('h3', {}, 'פתקים'),
      h('button', { class: 'icon-btn', onclick: closeChat }, '✕')),
    h('div', { class: 'msgs' }),
    h('div', { class: 'quick' }, QUICK.map(q => h('button', { onclick: () => send(q) }, q))),
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
  ensureChatFab();
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
  if (fab) { fab.remove(); fab = null; }
  const nameIn = h('input', { class: 'paper', placeholder: 'השם שלי', maxlength: 14, value: store.get('name', '') });
  const codeIn = h('input', { class: 'paper code', placeholder: '____', inputmode: 'numeric', maxlength: 4, value: room || '' });
  const getName = () => {
    const n = nameIn.value.trim();
    if (!n) { toast('קודם כותבים שם 🙂'); nameIn.focus(); return null; }
    store.set('name', n);
    return cleanName(n);
  };
  const join = () => {
    const n = getName(); if (!n) return;
    const code = codeIn.value.replace(/\D/g, '');
    if (code.length !== 4) { toast('הקוד הוא 4 ספרות'); codeIn.focus(); return; }
    startGuest(n, code);
  };
  const doodle = h('div', { class: 'center', style: { fontSize: '15px', margin: '4px 0 6px' }, html:
    'בול פגיעה · איש תלוי · צוללות · נקודות · 5 בשורה' });
  const kids = [
    h('h1', { class: 'center', style: { fontSize: '64px', marginTop: '22px' } }, 'דף ועיפרון'),
    doodle,
    h('p', { class: 'center soft' }, 'כל אחד עם הטלפון שלו – כמו הדף שהיה לכל אחד מול העיניים.'),
    h('div', { class: 'card stack' }, h('label', {}, 'איך קוראים לך?'), nameIn),
  ];
  if (room) {
    kids.push(h('div', { class: 'card stack center' },
      h('h3', {}, 'הוזמנת לשחק!'),
      h('div', {}, 'קוד הדף'), h('div', { class: 'code-big' }, room),
      h('button', { class: 'btn big marker', onclick: () => { codeIn.value = room; join(); } }, 'הצטרפות ✏️')));
  } else {
    kids.push(
      h('button', { class: 'btn big marker mt', onclick: () => { const n = getName(); if (n) startHost(n); } }, '📄 פותחים דף חדש'),
      h('p', { class: 'center soft' }, '— או —'),
      h('div', { class: 'card stack' }, h('label', {}, 'יש לי קוד מהטלפון השני:'), codeIn,
        h('button', { class: 'btn', onclick: join }, 'הצטרפות')));
  }
  kids.push(
    room ? null : h('div', { class: 'card' },
      h('b', {}, 'איך זה עובד?'),
      h('ol', { class: 'help' },
        h('li', {}, 'אחד פותח דף חדש ומקבל קוד של 4 ספרות.'),
        h('li', {}, 'השני מצטרף עם הקישור או עם הקוד.'),
        h('li', {}, 'משחקים – כל אחד בטלפון שלו, והכול מסתנכרן.'))),
    h('p', { class: 'center soft', style: { fontSize: '12px' } }, `גרסה ${VERSION} · האתר שולח נתוני חיבור טכניים אנונימיים כדי לאתר תקלות (בלי שמות ובלי תוכן המשחק).`));
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
  session = { role: 'host', code, token: deviceToken(), name, fresh: true };
  store.set('session', session);
  state = newState(name, session.token);
  store.set('state:' + code, state);
  history.replaceState(null, '', location.pathname + (LOCAL ? location.search : ''));
  startNet();
  onState();
}

function startGuest(name, code) {
  session = { role: 'guest', code, token: deviceToken(), name };
  store.set('session', session);
  store.del('gstate:' + code); // a fresh join never trusts an old copy of some other evening
  state = null;
  startNet();
  state ? onState() : render();
}

function leaveRoom() {
  net && net.destroy(); net = null;
  clearInterval(outboxTimer); outbox = [];
  store.del('session');
  session = null; state = null; seenChat = null; prevGameKey = null; link = 'waiting';
  setLogContext('');
  closeChat();
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

async function boot() {
  await claimPrimaryTab();
  session = store.get('session', null);
  const room = (params.get('room') || '').replace(/\D/g, '').slice(0, 4);
  if (session && (!room || room === session.code)) {
    if (session.role === 'host') {
      state = store.get('state:' + session.code, null) || newState(session.name, session.token);
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
window.__dv = { get net() { return net; }, get state() { return state; }, get link() { return link; }, get session() { return session; }, get outbox() { return outbox; }, get log() { return logRing; } };
boot();

import { h, toast, confirmBox, tally, buzz, rid } from './ui.js';
import { HostNet, GuestNet, LOCAL } from './net.js';
import bull from './games/bull.js';
import hangman from './games/hangman.js';
import ships from './games/ships.js';
import dots from './games/dots.js';
import five from './games/five.js';

const GAMES = [bull, hangman, ships, dots, five];
const BY = Object.fromEntries(GAMES.map(G => [G.id, G]));
const params = new URLSearchParams(location.search);
const NS = 'dv:' + (params.get('local') || '') + ':';

const store = {
  get(k, d) { try { const v = localStorage.getItem(NS + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(NS + k); } catch { /* ignore */ } },
};

const app = document.getElementById('app');
let session = store.get('session', null);
let state = null;
let net = null;
let link = 'waiting';
let me = 0;
let prevMyTurn = null;
let prevGameKey = null;
let seenChat = null;
let chatOpen = false;
let unread = 0;

const cleanName = n => String(n || '').trim().slice(0, 14) || 'שחקן';

/* ======================= shared state & reducer ======================= */

function newState(name, token) {
  return {
    v: 1, rev: 0,
    players: [{ name, token }, { name: null, token: null }],
    score: Object.fromEntries(GAMES.map(G => [G.id, [0, 0, 0]])), // [wins p0, wins p1, ties]
    starter: Object.fromEntries(GAMES.map(G => [G.id, 0])),
    current: null, game: null, lastDone: null,
    chat: [],
  };
}

function reduce(s, p, a) {
  if (!a || typeof a !== 'object') return false;
  switch (a.k) {
    case 'chat': {
      const text = String(a.text || '').trim().slice(0, 240);
      if (!text) return false;
      s.chat.push({ id: rid(), p, text, t: Date.now() });
      if (s.chat.length > 80) s.chat.splice(0, s.chat.length - 80);
      return true;
    }
    case 'pick': {
      const G = BY[a.game];
      if (!G || !s.players[1].token) return false;
      const st = s.starter[a.game];
      s.starter[a.game] = 1 - st;
      s.current = a.game;
      s.game = G.init(st);
      s.game.id = rid();
      s.game.counted = false;
      return true;
    }
    case 'menu':
      s.current = null; s.game = null; s.leftBy = p;
      return true;
    case 'resetScores':
      s.score = Object.fromEntries(GAMES.map(G => [G.id, [0, 0, 0]]));
      s.lastDone = null;
      return true;
    case 'g': {
      if (!s.game || s.game.over) return false;
      const G = BY[s.current];
      if (G.apply(s.game, a.a, p) === false) return false;
      if (s.game.over && !s.game.counted) {
        const w = s.game.over.winner;
        s.score[s.current][w == null ? 2 : w]++;
        s.game.counted = true;
        s.lastDone = s.current;
      }
      return true;
    }
  }
  return false;
}

function commit(s) {
  s.rev++;
  state = s;
  store.set('state:' + session.code, s);
  net && net.send({ t: 'state', s });
  onState();
}

function hostDispatch(p, a) {
  const s = structuredClone(state);
  if (!reduce(s, p, a)) return;
  commit(s);
}

function act(a) {
  if (session.role === 'host') { hostDispatch(0, a); return; }
  if (link !== 'linked') { toast('אין חיבור כרגע… מנסה להתחבר שוב'); net && net.wake(); return; }
  net.send({ t: 'act', a });
}

/* ======================= networking ======================= */

function startNet() {
  me = session.role === 'host' ? 0 : 1;
  if (session.role === 'host') {
    net = new HostNet(session.code, {
      accept: d => !state.players[1].token || state.players[1].token === d.token,
      onHello: d => {
        const s = structuredClone(state);
        const first = !s.players[1].token;
        s.players[1] = { name: cleanName(d.name), token: d.token };
        commit(s);
        if (first) toast(`${s.players[1].name} הצטרף/ה לדף! ✏️`);
      },
      onMessage: d => { if (d.t === 'act') hostDispatch(1, d.a); },
      onStatus: st => { link = st; render(); },
    });
  } else {
    net = new GuestNet(session.code, {
      hello: () => ({ t: 'hello', token: session.token, name: session.name }),
      onMessage: d => {
        if (d.t === 'state' && d.s) { state = d.s; store.set('gstate:' + session.code, state); onState(); }
        else if (d.t === 'full') { link = 'full'; render(); }
      },
      onStatus: st => { link = st; render(); },
    });
  }
  net.start();
}

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

function render() {
  if (!session) return;
  if (!state) { renderConnecting(); return; }
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
  app.replaceChildren(...kids);
  if (gameRoot) G.render(gameRoot, state.game, ctx);
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
  const other = (state && state.players[1 - me].name) || 'השותף';
  const msg = {
    waiting: me === 0 ? `מחכים ש${other} יתחבר/תתחבר…` : 'מתחבר…',
    'no-host': `לא מוצא את הדף של ${other}. האם המסך שלו/ה פתוח?`,
    offline: 'אין אינטרנט כרגע, מנסה שוב…',
    full: 'בדף הזה כבר משחקים שניים 🙁',
  }[link] || 'מתחבר…';
  return h('div', { class: 'note warn' }, '📡 ', msg);
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
  return h('div', { class: 'card center' },
    h('h3', {}, 'מזמינים שותף לדף'),
    h('div', {}, 'הקוד של הדף:'),
    h('div', { class: 'code-big' }, session.code),
    h('p', { class: 'soft' }, 'בטלפון השני: פותחים את הקישור, או נכנסים לאתר ומקלידים את הקוד.'),
    h('div', { class: 'row center' },
      h('button', { class: 'btn marker', onclick: shareInvite }, '📤 שליחת הזמנה'),
      h('a', { class: 'btn', href: 'https://wa.me/?text=' + encodeURIComponent('בוא/י לשחק איתי ✏️ ' + url), target: '_blank', rel: 'noopener' }, 'וואטסאפ')));
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
      const s = structuredClone(state); s.players[1].token = null; commit(s);
    },
  }, 'החלפת שותף'));
  foot.append(h('button', {
    class: 'link-btn', onclick: async () => {
      if (await confirmBox('לצאת מהדף הזה? (אפשר לחזור עם הקוד)', 'יציאה', 'ביטול')) leaveRoom();
    },
  }, 'יציאה מהדף'));
  wrap.append(foot);
  return wrap;
}

function renderConnecting() {
  app.replaceChildren(
    h('header', { class: 'top' }, h('div', { class: 'logo' }, 'דף ועיפרון')),
    h('div', { class: 'card center' },
      h('h2', {}, 'מתחברים לדף ' + session.code),
      connNote(),
      h('button', { class: 'link-btn', onclick: leaveRoom }, 'ביטול')));
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
  app.replaceChildren(...kids);
}

function deviceToken() {
  let t = store.get('token', null);
  if (!t) { t = rid(12); store.set('token', t); }
  return t;
}

function startHost(name) {
  const code = String(Math.floor(1000 + Math.random() * 9000));
  session = { role: 'host', code, token: deviceToken(), name };
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
  state = store.get('gstate:' + code, null);
  startNet();
  state ? onState() : render();
}

function leaveRoom() {
  net && net.destroy(); net = null;
  store.del('session');
  session = null; state = null; seenChat = null; prevGameKey = null;
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

function boot() {
  const room = (params.get('room') || '').replace(/\D/g, '').slice(0, 4);
  if (session && (!room || room === session.code)) {
    if (session.role === 'host') {
      state = store.get('state:' + session.code, null) || newState(session.name, session.token);
    } else {
      state = store.get('gstate:' + session.code, null);
    }
    startNet();
    state ? onState() : render();
    return;
  }
  homeView(room || null);
}
boot();

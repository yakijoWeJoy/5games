// Run: node tests/logic.test.mjs
// Fuzzes the shared reducer and all five games: random legal play, garbage input, invariants.
import assert from 'node:assert/strict';
import { GAMES, newState, reduce, seriesWins, seriesDecided, seriesDone, nextGame } from '../js/core.js';
import { gameEvents } from '../js/metrics.js';
import { SHIPS, randomLayout, validLayout } from '../js/games/ships.js';

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = n => Math.floor(rnd() * n);
const pick = a => a[ri(a.length)];
const clone = x => JSON.parse(JSON.stringify(x));

function fresh() {
  const s = newState('A', 'ta');
  s.players[1] = { name: 'B', token: 'tb' };
  return s;
}
const step = (s, p, a) => { const c = clone(s); const ok = reduce(c, p, a); return ok ? c : null; };
// state must survive JSON (it is sent between phones and saved in localStorage)
const jsonSafe = s => assert.deepEqual(clone(s), s);

const GARBAGE = [null, undefined, 0, 'x', [], {}, { k: 'g' }, { k: 'g', a: null }, { k: 'g', a: {} }, { k: 'g', a: { k: 'zzz' } },
  { k: 'pick', game: 'bull' }, { k: 'jump', game: 'bull' }, { k: 'jump', game: '__proto__' }, { k: 'nope' }, { k: 'next', from: 'wrong' }, { k: 'replay', from: 'wrong' }, { k: 'newSeries', n: -5 }, { k: 'newSeries', from: 'wrong' },
  { k: 'g', a: { k: 'guess', code: 1234 } }, { k: 'g', a: { k: 'guess', code: '1123' } }, { k: 'g', a: { k: 'secret', code: 'abcd' } },
  { k: 'g', a: { k: 'letter', l: null } }, { k: 'g', a: { k: 'letter', l: 'אב' } }, { k: 'g', a: { k: 'word', text: 'a', lang: 'en' } },
  { k: 'g', a: { k: 'word', text: 'שלום', lang: 'xx' } }, { k: 'g', a: { k: 'word', text: '<b>', lang: 'en' } },
  { k: 'g', a: { k: 'solve' } }, { k: 'g', a: { k: 'solve', text: {} } },
  { k: 'g', a: { k: 'ready' } }, { k: 'g', a: { k: 'ready', ships: [] } }, { k: 'g', a: { k: 'ready', ships: [1, 2, 3, 4] } },
  { k: 'g', a: { k: 'ready', ships: [{ id: 'nun', cells: [[0, 0]] }, { id: 's4' }, { id: 's3' }, { id: 's2' }] } },
  { k: 'g', a: { k: 'shot' } }, { k: 'g', a: { k: 'shot', r: -1, c: 0 } }, { k: 'g', a: { k: 'shot', r: 1.5, c: 0 } }, { k: 'g', a: { k: 'shot', r: '1', c: '1' } },
  { k: 'g', a: { k: 'line' } }, { k: 'g', a: { k: 'line', o: 'h', r: 99, c: 0 } }, { k: 'g', a: { k: 'line', o: 'x', r: 0, c: 0 } },
  { k: 'g', a: { k: 'line', o: 'h', r: 0, c: 5 } }, { k: 'g', a: { k: 'line', o: 'v', r: 5, c: 0 } }, { k: 'g', a: { k: 'line', o: 'h', r: '0', c: 0 } },
  { k: 'g', a: { k: 'put' } }, { k: 'g', a: { k: 'put', i: -1 } }, { k: 'g', a: { k: 'put', i: 441 } }, { k: 'g', a: { k: 'put', i: 2.5 } }, { k: 'g', a: { k: 'put', i: '3' } },
  { k: 'chat' }, { k: 'chat', text: '   ' }, { k: 'menu', from: 'wrong' }, { k: 'g', gid: 'wrong', a: { k: 'put', i: 0 } },
];

/** throw garbage at the state from both players: nothing may change and nothing may throw */
function garbage(s) {
  for (const g of GARBAGE) for (const p of [0, 1, 2, -1, null]) {
    const before = JSON.stringify(s);
    const c = clone(s);
    let ok;
    assert.doesNotThrow(() => { ok = reduce(c, p, g); }, `garbage threw: ${JSON.stringify(g)}`);
    assert.equal(ok, false, `garbage accepted: ${JSON.stringify(g)} in ${s.current}`);
    assert.equal(JSON.stringify(s), before);
  }
}

// ---------- legal move generators (what the UI would allow) ----------
const digits4 = () => { const d = '0123456789'.split(''); let o = ''; for (let i = 0; i < 4; i++) o += d.splice(ri(d.length), 1)[0]; return o; };
const HE = 'אבגדהוזחטיכלמנסעפצקרשת'.split(''), EN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const WORDS = [['שלום', 'he'], ['ארץ ישראל', 'he'], ['מים', 'he'], ['ךםןףץ', 'he'], ['cat', 'en'], ['Hello World', 'en'], ['ZZ', 'en'], ['אבא ואמא הלכו לים', 'he']];

const legal = {
  bull(g, p) {
    if (g.phase === 'secret') return g.secrets[p] ? [] : [{ k: 'secret', code: digits4() }];
    if (g.turn !== p) return [];
    // sometimes guess right, to end games
    const code = rnd() < 0.15 ? g.secrets[1 - p] : digits4();
    return g.guesses[p].some(x => x.code === code) ? [] : [{ k: 'guess', code }];
  },
  hangman(g, p) {
    if (g.phase === 'word') { if (g.words[p]) return []; const [text, lang] = pick(WORDS); return [{ k: 'word', text, lang, hint: rnd() < .5 ? 'רמז' : '' }]; }
    if (g.turn !== p) return [];
    const t = g.words[1 - p];
    if (rnd() < 0.05) return [{ k: 'solve', text: rnd() < .5 ? t.text : 'לא נכון' }];
    const left = (t.lang === 'en' ? EN : HE).filter(l => !g.guessed[p].includes(l));
    return left.length ? [{ k: 'letter', l: pick(left) }] : [{ k: 'solve', text: t.text }];
  },
  ships(g, p) {
    if (g.phase === 'place') { if (g.layouts[p]) return []; const pl = randomLayout(); return [{ k: 'ready', ships: SHIPS.map(d => ({ id: d.id, cells: pl[d.id] })) }]; }
    if (g.turn !== p) return [];
    const out = [];
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) out.push({ k: 'shot', r, c });
    return [pick(out)]; // may be illegal (already shot / auto cell) – handled by caller
  },
  dots(g, p) {
    if (g.turn !== p) return [];
    const out = [];
    g.h.forEach((row, r) => row.forEach((v, c) => { if (v < 0) out.push({ k: 'line', o: 'h', r, c }); }));
    g.v.forEach((row, r) => row.forEach((v, c) => { if (v < 0) out.push({ k: 'line', o: 'v', r, c }); }));
    return out.length ? [pick(out)] : [];
  },
  five(g, p) {
    if (g.turn !== p) return [];
    const free = []; g.cells.forEach((v, i) => { if (v < 0) free.push(i); });
    // cluster moves near the centre so games end
    const near = free.filter(i => Math.abs(Math.floor(i / 21) - 10) < 4 && Math.abs(i % 21 - 10) < 4);
    return [{ k: 'put', i: pick(near.length && rnd() < .9 ? near : free) }];
  },
};

// ---------- per-game invariants ----------
const inv = {
  bull(g) {
    assert.ok(Math.abs(g.guesses[0].length - g.guesses[1].length) <= 1);
    for (const p of [0, 1]) for (const x of g.guesses[p]) {
      assert.ok(x.b >= 0 && x.p >= 0 && x.b + x.p <= 4);
      assert.equal(x.b === 4, x.code === g.secrets[1 - p]);
    }
    if (g.over) {
      const s0 = g.guesses[0].some(x => x.b === 4), s1 = g.guesses[1].some(x => x.b === 4);
      assert.ok(s0 || s1);
      assert.equal(g.guesses[0].length, g.guesses[1].length, 'equal number of turns');
      assert.equal(g.over.winner, s0 && s1 ? null : s0 ? 0 : 1);
    }
  },
  hangman(g) {
    for (const p of [0, 1]) { assert.ok(g.wrong[p] <= 10); assert.equal(new Set(g.guessed[p]).size, g.guessed[p].length); }
    if (g.over) {
      if (g.over.hanged != null) { assert.equal(g.wrong[g.over.hanged], 10); assert.equal(g.over.winner, 1 - g.over.hanged); }
      else {
        const w = g.over.winner, t = g.words[1 - w].text;
        const FIN = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
        for (const ch of t) if (ch !== ' ') assert.ok(g.guessed[w].includes(FIN[ch] || ch.toUpperCase()), 'winner revealed every letter');
      }
    }
  },
  ships(g) {
    for (const p of [0, 1]) {
      if (g.layouts[p]) assert.ok(validLayout(g.layouts[p]));
      const keys = g.shots[p].map(x => x.r * 6 + x.c);
      assert.equal(new Set(keys).size, keys.length, 'no cell shot twice');
      if (g.phase === 'play') {
        const enemy = g.layouts[1 - p];
        const hitCells = g.shots[p].filter(x => x.res !== 'miss').length;
        const sunkCells = g.sunk[p].reduce((a, id) => a + enemy.find(x => x.id === id).cells.length, 0);
        assert.ok(hitCells >= sunkCells);
        for (const x of g.shots[p]) assert.equal(x.res !== 'miss', enemy.some(sh => sh.cells.some(([r, c]) => r === x.r && c === x.c)));
      }
    }
    if (g.over) assert.equal(g.sunk[g.over.winner].length, 4);
  },
  dots(g) {
    let done = 0;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
      const full = g.h[r][c] >= 0 && g.h[r + 1][c] >= 0 && g.v[r][c] >= 0 && g.v[r][c + 1] >= 0;
      assert.equal(g.box[r][c] >= 0, full, 'box owned iff closed');
      if (full) done++;
    }
    assert.equal(!!g.over, done === 25);
    if (g.over) {
      const n0 = g.box.flat().filter(x => x === 0).length;
      assert.equal(g.over.winner, n0 > 12 ? 0 : 1);
    }
  },
  five(g) {
    const n0 = g.cells.filter(x => x === 0).length, n1 = g.cells.filter(x => x === 1).length;
    const first = g.starter;
    const nf = first === 0 ? n0 : n1, ns = first === 0 ? n1 : n0;
    assert.ok(nf - ns === 0 || nf - ns === 1, 'alternating turns');
    // brute-force five-in-a-row detection must agree with the game
    let found = null;
    for (let r = 0; r < 21; r++) for (let c = 0; c < 21; c++) for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const p = g.cells[r * 21 + c]; if (p < 0) continue;
      let k = 1; while (k < 5) { const rr = r + dr * k, cc = c + dc * k; if (rr < 0 || rr >= 21 || cc < 0 || cc >= 21 || g.cells[rr * 21 + cc] !== p) break; k++; }
      if (k === 5) found = p;
    }
    if (found != null) assert.deepEqual(g.over, { winner: found }); else assert.ok(!g.over || g.over.winner === null);
  },
};

function playOne(id, s0) {
  assert.equal(nextGame(s0), id, 'the series is played in order');
  let s = step(s0, ri(2), { k: 'next', from: s0.game ? s0.game.id : null });
  assert.ok(s, 'next works');
  assert.equal(s.current, id);
  const gid = s.game.id;
  const before = clone(s.series.results);
  let guard = 0;
  while (!s.game.over) {
    assert.ok(++guard < 5000, id + ' never ends');
    if (guard % 7 === 0) garbage(s);
    // the series cannot move on while a game is being played
    if (guard % 11 === 0) { assert.equal(step(s, 0, { k: 'next' }), null); assert.equal(step(s, 1, { k: 'replay' }), null); }
    const p = ri(2);
    const moves = legal[id](s.game, p);
    if (!moves.length) {
      // not this player's turn: every move the other player could make must be refused for p
      for (const m of legal[id](s.game, 1 - p)) {
        if (m.k === 'secret' || m.k === 'word' || m.k === 'ready') continue; // simultaneous phases
        assert.equal(step(s, p, { k: 'g', gid, a: m }), null, `${id}: move out of turn accepted`);
      }
      continue;
    }
    const m = moves[0];
    const n = step(s, p, { k: 'g', gid, a: m });
    if (!n) { assert.equal(id, 'ships', `${id}: legal move refused ${JSON.stringify(m)}`); continue; } // ships: random cell may be used
    s = n;
    jsonSafe(s);
    inv[id](s.game);
  }
  // exactly one result was written down
  assert.deepEqual(s.series.results, [...before, { game: id, winner: s.game.over.winner }], 'result counted exactly once');
  // nothing can be played after the end
  for (const p of [0, 1]) for (const m of [...legal[id]({ ...s.game, over: null }, p)]) assert.equal(step(s, p, { k: 'g', gid, a: m }), null);
  garbage(s);
  return s;
}

// ---------- run: 60 full series ----------
let s = fresh();
garbage(s);
assert.equal(step(newState('A', 't'), 0, { k: 'next' }), null, 'cannot start before a partner joined');
assert.equal(step(s, 0, { k: 'menu' }), null, 'menu with no game is a no-op');

const counts = {};
let expectEvening = [0, 0, 0];
for (let round = 0; round < 60; round++) {
  assert.equal(s.series.n, round + 1);
  for (const G of GAMES) {
    s = playOne(G.id, s);
    counts[G.id] = (counts[G.id] || 0) + 1;
  }
  assert.ok(seriesDone(s)); assert.equal(nextGame(s), null);
  assert.equal(step(s, 0, { k: 'next' }), null, 'no sixth game');
  const w = seriesWins(s);
  expectEvening[w[0] > w[1] ? 0 : w[1] > w[0] ? 1 : 2]++;
  s = step(s, ri(2), { k: 'newSeries', n: s.series.n });
  assert.ok(s);
  assert.deepEqual(s.evening, expectEvening, 'a finished series goes into the evening tally exactly once');
  assert.deepEqual(s.series.results, []);
}
assert.equal(s.evening.reduce((a, b) => a + b, 0), 60);

/** a state that is inside game `id` (test-only jump) */
const at = id => { const t = fresh(); assert.ok(reduce(t, 0, { k: 'jump', game: id }, { test: true })); return t; };
assert.equal(step(fresh(), 0, { k: 'jump', game: 'dots' }), null, 'jump is test-only');
{ // a jumped game is outside the series
  let t = at('five');
  const a = t.game.turn;
  for (let k = 0; k < 5; k++) { t = step(t, a, { k: 'g', a: { k: 'put', i: 10 * 21 + k } }); if (k < 4) t = step(t, 1 - a, { k: 'g', a: { k: 'put', i: 15 * 21 + k } }); }
  assert.ok(t.game.over); assert.deepEqual(t.series.results, []);
  assert.equal(step(t, 0, { k: 'replay' }), null);
}

// ---------- series rules ----------
/** finish the current game quickly with winner w (five in a row / bull are easy to steer) */
function win(t, w) {
  const G = (p, a) => { const n = step(t, p, { k: 'g', a }); assert.ok(n, JSON.stringify(a)); t = n; };
  switch (t.current) {
    case 'bull': {
      G(0, { k: 'secret', code: '1234' }); G(1, { k: 'secret', code: '5678' });
      const sec = p => (p === 0 ? '5678' : '1234');
      const f = t.game.turn;
      G(f, { k: 'guess', code: f === w ? sec(f) : '9012' });
      if (!t.game.over) G(1 - f, { k: 'guess', code: 1 - f === w ? sec(1 - f) : '9013' });
      if (w === null) assert.fail('use tie() for ties');
      break;
    }
    case 'hangman': {
      G(0, { k: 'word', text: 'אב', lang: 'he' }); G(1, { k: 'word', text: 'גד', lang: 'he' });
      if (t.game.turn !== w) G(t.game.turn, { k: 'letter', l: 'ק' });
      for (const l of (w === 0 ? 'גד' : 'אב')) G(w, { k: 'letter', l });
      break;
    }
    case 'ships': {
      const lay = [{ id: 'nun', cells: [[0, 0], [0, 1], [1, 0], [2, 0], [3, 0]] }, { id: 's4', cells: [[2, 2], [2, 3], [2, 4], [2, 5]] }, { id: 's3', cells: [[5, 0], [5, 1], [5, 2]] }, { id: 's2', cells: [[4, 4], [5, 4]] }];
      G(0, { k: 'ready', ships: lay }); G(1, { k: 'ready', ships: lay });
      if (t.game.turn !== w) G(t.game.turn, { k: 'shot', r: 0, c: 5 });
      for (const sh of lay) for (const [r, c] of sh.cells) G(w, { k: 'shot', r, c }); // every hit keeps the turn
      break;
    }
    case 'dots': {
      // steer: the winner closes boxes greedily, the loser never closes one when avoidable
      let guard = 0;
      while (!t.game.over) {
        assert.ok(++guard < 200);
        const p = t.game.turn, g = t.game;
        const all = [];
        g.h.forEach((row, r) => row.forEach((v, c) => { if (v < 0) all.push({ k: 'line', o: 'h', r, c }); }));
        g.v.forEach((row, r) => row.forEach((v, c) => { if (v < 0) all.push({ k: 'line', o: 'v', r, c }); }));
        const scored = all.map(m => { const n = step(t, p, { k: 'g', a: m }); return { m, got: n.game.lastGot, gives: n.game.turn !== p ? Math.max(0, ...all.filter(x => x !== m).map(x => { const z = step(n, 1 - p, { k: 'g', a: x }); return z ? z.game.lastGot : 0; })) : 0 }; });
        scored.sort((a, b) => (p === w ? b.got - a.got || a.gives - b.gives : a.got - b.got || b.gives - a.gives));
        G(p, scored[0].m);
      }
      break;
    }
    case 'five': {
      let k = 0, j = 0;
      while (!t.game.over) { const p = t.game.turn; G(p, { k: 'put', i: p === w ? 10 * 21 + 3 + k++ : (2 + 2 * j++) * 21 + 1 }); }
      break;
    }
  }
  assert.equal(t.game.over.winner, w, `${t.current} steered to ${w}`);
  return t;
}
const next = t => { const n = step(t, 0, { k: 'next' }); assert.ok(n, 'next'); return n; };
{
  // who opens: alternates game to game and series to series
  let t = next(fresh());
  assert.equal(t.current, 'bull'); assert.equal(t.game.turn, 1);
  // two phones press "start" at the same moment: only the first one counts
  assert.equal(step(t, 1, { k: 'next', from: null }), null);
  assert.equal(step(t, 1, { k: 'next' }), null, 'no skipping a game that is being played');
  // leaving mid-game: nothing is written, the same game starts again from scratch
  const gid = t.game.id;
  t = step(t, 1, { k: 'menu', from: gid });
  assert.deepEqual(t.series.results, []); assert.equal(t.leftBy, 1); assert.equal(nextGame(t), 'bull');
  assert.equal(step(t, 0, { k: 'g', gid, a: { k: 'secret', code: '1234' } }), null, 'a move for the abandoned game is refused');
  t = next(t); assert.equal(t.current, 'bull'); assert.notEqual(t.game.id, gid); assert.equal(t.game.turn, 1);

  t = win(t, 0);
  assert.deepEqual(seriesWins(t), [1, 0, 0]);
  // replay: the result is erased, same opener, and it is the same game again
  const r = step(t, 1, { k: 'replay' });
  assert.ok(r); assert.equal(r.current, 'bull'); assert.deepEqual(r.series.results, []); assert.equal(r.game.turn, 1); assert.equal(r.game.over, null);
  assert.equal(step(r, 0, { k: 'replay' }), null, 'cannot replay a game that is not over');
  t = win(r, 1);
  assert.deepEqual(seriesWins(t), [0, 1, 0], 'only the replayed result counts');
  // double press on "next game"
  const from = t.game.id;
  const a = step(t, 0, { k: 'next', from });
  assert.equal(a.current, 'hangman'); assert.equal(a.game.turn, 0);
  assert.equal(step(a, 1, { k: 'next', from }), null);
  assert.equal(step(a, 1, { k: 'replay', from }), null, 'replay of the previous game is no longer possible');
  t = win(a, 1);
  assert.equal(seriesDecided(t), null);
  t = win(next(t), 1);
  // three wins: decided before the fifth game – but playing on is allowed
  assert.equal(seriesDecided(t), 1); assert.equal(seriesDone(t), false); assert.equal(nextGame(t), 'dots');
  let u = win(next(t), 0);
  u = win(next(u), 0);
  assert.ok(seriesDone(u)); assert.deepEqual(seriesWins(u), [2, 3, 0]); assert.equal(seriesDecided(u), 1);
  assert.equal(step(u, 0, { k: 'next' }), null);
  assert.ok(step(u, 0, { k: 'replay' }), 'the last game can still be replayed');
  u = step(u, 0, { k: 'newSeries', n: 1 });
  assert.deepEqual(u.evening, [0, 1, 0]); assert.equal(u.series.n, 2); assert.equal(u.game, null);
  assert.equal(step(u, 1, { k: 'newSeries', n: 1 }), null, 'two phones pressing "new series" start only one');
  // new series right after it was decided (without playing to the end) still counts
  const v = step(t, 1, { k: 'newSeries' });
  assert.deepEqual(v.evening, [0, 1, 0]);
  // a new series in the middle of an undecided one: nobody gets it
  let m = win(next(fresh()), 0);
  m = step(m, 0, { k: 'newSeries' });
  assert.deepEqual(m.evening, [0, 0, 0]); assert.equal(m.series.n, 2);
  // in series 2 the other player opens the first game
  assert.equal(next(m).game.turn, 0);
  // new series while a game is being played is allowed (any time)
  m = step(next(m), 1, { k: 'newSeries' });
  assert.ok(m); assert.equal(m.series.n, 3); assert.equal(m.game, null);
  // reset
  const z = step(u, 0, { k: 'resetEvening' });
  assert.deepEqual(z.evening, [0, 0, 0]); assert.equal(z.series.n, 1);
  // a tied series: 2:2 and one tie
  let q = fresh();
  q = next(q);
  { // bull tie: both crack the code in the same round
    const G = (p, a2) => { q = step(q, p, { k: 'g', a: a2 }); assert.ok(q); };
    G(0, { k: 'secret', code: '1234' }); G(1, { k: 'secret', code: '5678' });
    const f = q.game.turn; G(f, { k: 'guess', code: f === 0 ? '5678' : '1234' }); G(1 - f, { k: 'guess', code: f === 0 ? '1234' : '5678' });
    assert.deepEqual(q.game.over, { winner: null });
  }
  for (const w of [0, 1, 0, 1]) q = win(next(q), w);
  assert.deepEqual(seriesWins(q), [2, 2, 1]); assert.equal(seriesDecided(q), null);
  q = step(q, 0, { k: 'newSeries' });
  assert.deepEqual(q.evening, [0, 0, 1]);
}

// chat is capped and trimmed
{
  let t = fresh();
  for (let i = 0; i < 100; i++) t = step(t, i % 2, { k: 'chat', text: ' הודעה ' + i + ' '.repeat(300) + 'x'.repeat(400) });
  assert.equal(t.chat.length, 80);
  assert.ok(t.chat.every(m => m.text.length <= 240));
}

// ---------- specific rule checks ----------
{
  // bull: bulls/hits counting, equal number of turns
  let t = at('bull');
  t = step(t, 0, { k: 'g', a: { k: 'secret', code: '0123' } });
  assert.equal(step(t, 0, { k: 'g', a: { k: 'secret', code: '4567' } }), null, 'secret cannot be changed');
  assert.equal(step(t, 0, { k: 'g', a: { k: 'guess', code: '4567' } }), null, 'no guessing before both chose');
  t = step(t, 1, { k: 'g', a: { k: 'secret', code: '4567' } });
  const f = t.game.turn, o = 1 - f, secOf = p => (p === 0 ? '0123' : '4567');
  assert.equal(step(t, o, { k: 'g', a: { k: 'guess', code: secOf(f) } }), null, 'not your turn');
  const near = p => (p === 0 ? '4576' : '3210'); // guesses at the other player's code
  t = step(t, f, { k: 'g', a: { k: 'guess', code: near(f) } });
  assert.deepEqual([t.game.guesses[f][0].b, t.game.guesses[f][0].p], f === 0 ? [2, 2] : [0, 4]);
  t = step(t, o, { k: 'g', a: { k: 'guess', code: near(o) } });
  assert.equal(step(t, f, { k: 'g', a: { k: 'guess', code: near(f) } }), null, 'same guess twice');
  t = step(t, f, { k: 'g', a: { k: 'guess', code: secOf(o) } }); assert.equal(t.game.over, null, 'second player gets a last chance');
  t = step(t, o, { k: 'g', a: { k: 'guess', code: secOf(f) } }); assert.deepEqual(t.game.over, { winner: null });

  // hangman: a correct letter keeps the turn, a wrong one passes it; finals count as regular letters
  t = at('hangman');
  t = step(t, 0, { k: 'g', a: { k: 'word', text: '  שלום   עולם ', lang: 'he' } }); assert.equal(t.game.words[0].text, 'שלום עולם');
  t = step(t, 1, { k: 'g', a: { k: 'word', text: 'ab c', lang: 'en' } }); assert.equal(t.game.words[1].text, 'AB C');
  assert.equal(t.game.turn, 0);
  t = step(t, 0, { k: 'g', a: { k: 'letter', l: 'a' } }); assert.equal(t.game.wrong[0], 0); assert.equal(t.game.turn, 0, 'hit: another turn');
  assert.equal(step(t, 1, { k: 'g', a: { k: 'letter', l: 'מ' } }), null, 'not the other player yet');
  assert.equal(step(t, 0, { k: 'g', a: { k: 'letter', l: 'A' } }), null, 'letter already asked');
  assert.equal(step(t, 0, { k: 'g', a: { k: 'letter', l: 'ש' } }), null, 'hebrew letter on english word');
  t = step(t, 0, { k: 'g', a: { k: 'letter', l: 'Z' } }); assert.equal(t.game.wrong[0], 1); assert.equal(t.game.turn, 1, 'miss: turn passes');
  t = step(t, 1, { k: 'g', a: { k: 'letter', l: 'מ' } }); assert.equal(t.game.wrong[1], 0, 'מ reveals ם'); assert.equal(t.game.turn, 1);
  t = step(t, 1, { k: 'g', a: { k: 'solve', text: 'לא נכון' } }); assert.equal(t.game.wrong[1], 1); assert.equal(t.game.turn, 0, 'wrong whole-word guess passes the turn');
  t = step(t, 0, { k: 'g', a: { k: 'solve', text: 'abc' } }); assert.deepEqual(t.game.over, { winner: 0 });
  // finishing the word letter by letter in one run of turns
  t = at('hangman');
  t = step(t, 0, { k: 'g', a: { k: 'word', text: 'אב', lang: 'he' } });
  t = step(t, 1, { k: 'g', a: { k: 'word', text: 'גד', lang: 'he' } });
  t = step(t, 0, { k: 'g', a: { k: 'letter', l: 'ג' } }); t = step(t, 0, { k: 'g', a: { k: 'letter', l: 'ד' } });
  assert.deepEqual(t.game.over, { winner: 0 });
  // ten misses hang
  t = at('hangman');
  t = step(t, 0, { k: 'g', a: { k: 'word', text: 'אב', lang: 'he' } });
  t = step(t, 1, { k: 'g', a: { k: 'word', text: 'גד', lang: 'he' } });
  const bad0 = 'הוזחטיכלמנ'.split(''), bad1 = 'סעפצקרשתהו'.split('');
  for (let i = 0; i < 10 && !t.game.over; i++) { t = step(t, 0, { k: 'g', a: { k: 'letter', l: bad0[i] } }); if (!t.game.over) t = step(t, 1, { k: 'g', a: { k: 'letter', l: bad1[i] } }); }
  assert.deepEqual(t.game.over, { winner: 1, hanged: 0 });

  // dots: closing a box gives another turn
  t = at('dots');
  const d0 = t.game.turn, d1 = 1 - d0;
  const L = (p, o, r, c) => { const n = step(t, p, { k: 'g', a: { k: 'line', o, r, c } }); assert.ok(n, `line ${o}${r}${c} by ${p}`); t = n; };
  L(d0, 'h', 0, 0); L(d1, 'h', 1, 0); L(d0, 'v', 0, 0); L(d1, 'v', 0, 1);
  assert.equal(t.game.box[0][0], d1); assert.equal(t.game.turn, d1, 'extra turn after closing');
  assert.equal(step(t, d1, { k: 'g', a: { k: 'line', o: 'h', r: 0, c: 0 } }), null, 'line already drawn');
  L(d1, 'h', 0, 1); L(d0, 'h', 1, 1); L(d1, 'v', 0, 2); assert.equal(t.game.box[0][1], d1); assert.equal(t.game.turn, d1);

  // ships: touching layouts are refused; a hit keeps the turn, a miss passes it; sinking marks neighbours
  const bad = [{ id: 'nun', cells: [[0, 0], [0, 1], [1, 0], [2, 0], [3, 0]] }, { id: 's4', cells: [[1, 1], [1, 2], [1, 3], [1, 4]] }, { id: 's3', cells: [[5, 0], [5, 1], [5, 2]] }, { id: 's2', cells: [[5, 4], [5, 5]] }];
  assert.equal(validLayout(bad), false, 'diagonal touch refused');
  const good = [{ id: 'nun', cells: [[0, 0], [0, 1], [1, 0], [2, 0], [3, 0]] }, { id: 's4', cells: [[2, 2], [2, 3], [2, 4], [2, 5]] }, { id: 's3', cells: [[5, 0], [5, 1], [5, 2]] }, { id: 's2', cells: [[4, 4], [5, 4]] }];
  assert.equal(validLayout(good), true);
  assert.equal(validLayout([...good.slice(0, 3), { id: 's2', cells: [[4, 4], [5, 5]] }]), false, 'bent ship refused');
  assert.equal(validLayout([...good.slice(0, 3), { id: 's2', cells: [[4, 5], [4, 6]] }]), false, 'outside board refused');
  assert.equal(validLayout([good[0], good[1], good[2], good[2]]), false);
  t = at('ships');
  assert.equal(step(t, 0, { k: 'g', a: { k: 'ready', ships: bad } }), null);
  t = step(t, 0, { k: 'g', a: { k: 'ready', ships: good } });
  t = step(t, 1, { k: 'g', a: { k: 'ready', ships: good } });
  const sa = t.game.turn, sb = 1 - sa;
  t = step(t, sa, { k: 'g', a: { k: 'shot', r: 4, c: 4 } }); assert.equal(t.game.last.res, 'hit'); assert.equal(t.game.turn, sa, 'hit: shoot again');
  assert.equal(step(t, sb, { k: 'g', a: { k: 'shot', r: 0, c: 5 } }), null, 'not the other player yet');
  t = step(t, sa, { k: 'g', a: { k: 'shot', r: 5, c: 4 } }); assert.equal(t.game.last.res, 'sunk'); assert.equal(t.game.turn, sa, 'sunk: shoot again');
  assert.equal(step(t, sa, { k: 'g', a: { k: 'shot', r: 5, c: 5 } }), null, 'cell next to a sunk sub is known to be empty');
  assert.equal(step(t, sa, { k: 'g', a: { k: 'shot', r: 4, c: 4 } }), null, 'already shot');
  t = step(t, sa, { k: 'g', a: { k: 'shot', r: 0, c: 5 } }); assert.equal(t.game.last.res, 'miss'); assert.equal(t.game.turn, sb, 'miss: turn passes');

  // five: rows do not wrap, verticals on the edge, diagonals
  t = at('five');
  const fa = t.game.turn, fb = 1 - fa;
  const P = (p, r, c) => { const n = step(t, p, { k: 'g', a: { k: 'put', i: r * 21 + c } }); assert.ok(n); t = n; };
  P(fa, 0, 17); P(fb, 5, 5); P(fa, 0, 18); P(fb, 5, 7); P(fa, 0, 19); P(fb, 5, 9); P(fa, 0, 20); P(fb, 5, 11); P(fa, 1, 0);
  assert.equal(t.game.over, null, 'rows do not wrap around the edge');
  P(fb, 9, 9); P(fa, 4, 20); P(fb, 9, 11); P(fa, 3, 20); P(fb, 9, 13); P(fa, 2, 20); P(fb, 12, 12); P(fa, 1, 20);
  assert.deepEqual(t.game.over, { winner: fa }, 'vertical five on the edge');
  t = at('five');
  P(fa, 10, 10); P(fb, 0, 0); P(fa, 9, 11); P(fb, 0, 2); P(fa, 8, 12); P(fb, 0, 4); P(fa, 6, 14); P(fb, 0, 6); P(fa, 7, 13);
  assert.deepEqual(t.game.over, { winner: fa }, 'anti-diagonal, filled in the middle');
  assert.deepEqual(t.game.line, [6 * 21 + 14, 10 * 21 + 10]);
}

// ---------- five in a row: every X and O is drawn inside its own square, in all 441 squares ----------
{
  const { markXD, roughCircleD } = await import('../js/ui.js');
  const { FIVE } = await import('../js/games/five.js');
  const { N, U, MARK_X, MARK_O } = FIVE;
  const half = 1.5; // half of the pen width
  let worst = 0;
  for (let i = 0; i < N * N; i++) {
    const cx = (i % N) * U + U / 2, cy = Math.floor(i / N) * U + U / 2;
    for (const [name, d] of [['X', markXD(cx, cy, MARK_X).join(' ')], ['O', roughCircleD(cx, cy, MARK_O)]]) {
      const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
      assert.equal(nums.length % 2, 0);
      let far = 0;
      for (let k = 0; k < nums.length; k += 2) far = Math.max(far, Math.abs(nums[k] - cx), Math.abs(nums[k + 1] - cy));
      worst = Math.max(worst, far + half);
      assert.ok(far + half <= U / 2 - 1, `${name} in square ${i} reaches ${(far + half).toFixed(1)} from the centre (square is ±${U / 2})`);
      assert.ok(far > U * .2, `${name} in square ${i} is too small`);
    }
    // an O must really go around its centre: points in all four quadrants
    const o = roughCircleD(cx, cy, MARK_O).match(/-?\d+(\.\d+)?/g).map(Number);
    const q = new Set();
    for (let k = 0; k < o.length; k += 2) q.add((o[k] > cx ? 1 : 0) + (o[k + 1] > cy ? 2 : 0));
    assert.equal(q.size, 4, `O in square ${i} is not centred on its square`);
  }
  console.log(`five in a row: all ${N * N} squares checked, marks stay within ${worst.toFixed(1)} of the centre (square edge at ${U / 2})`);
}


// ---------- analytics events derived from state changes ----------
{
  const evs = [];
  let t = fresh(), seen = t;
  const go = (p, a) => { const n = step(t, p, a); assert.ok(n, JSON.stringify(a)); t = n; };
  const see = () => { for (const e of gameEvents(seen, t, 0)) evs.push(e); seen = t; };
  const names = () => evs.map(e => e.event);
  // game 1: host wins; game 2: abandoned to the menu by the guest; then played and won by guest
  go(0, { k: 'next', from: null }); see();
  t = win(t, 0); see();
  assert.deepEqual(names(), ['game_started', 'game_completed']);
  const done = evs[1].props;
  assert.equal(done.game, 'bull'); assert.equal(done.outcome, 'host_won'); assert.equal(done.my_outcome, 'won');
  assert.equal(done.game_index, 1); assert.ok(done.moves >= 3); assert.equal(done.series_score, '1-0'); assert.equal(done.is_rematch, false);
  assert.ok(typeof done.duration_s === 'number' && done.duration_s >= 0);
  go(1, { k: 'replay', from: t.game.id }); see();
  assert.equal(evs.at(-1).event, 'game_started'); assert.equal(evs.at(-1).props.is_rematch, true);
  t = win(t, 0); see();
  go(0, { k: 'next', from: t.game.id }); see();
  go(1, { k: 'menu', from: t.game.id }); see();
  const ab = evs.at(-1);
  assert.equal(ab.event, 'game_abandoned'); assert.equal(ab.props.reason, 'to_menu'); assert.equal(ab.props.left_by, 'guest'); assert.equal(ab.props.game, 'hangman');
  go(0, { k: 'next', from: null }); see(); t = win(t, 0); see();
  go(0, { k: 'next', from: t.game.id }); see(); t = win(t, 0); see();
  assert.equal(evs.filter(e => e.event === 'series_decided').length, 1, 'series decided at 3 wins');
  const dec = evs.find(e => e.event === 'series_decided').props;
  assert.equal(dec.winner, 'host'); assert.equal(dec.games_played, 3); assert.equal(dec.score, '3-0');
  go(0, { k: 'next', from: t.game.id }); see(); t = win(t, 1); see();
  go(0, { k: 'next', from: t.game.id }); see(); t = win(t, 1); see();
  const comp = evs.filter(e => e.event === 'series_completed');
  assert.equal(comp.length, 1); assert.equal(comp[0].props.played_on_after_decided, true); assert.equal(comp[0].props.score, '3-2');
  go(1, { k: 'newSeries', from: t.game.id, n: 1 }); see();
  assert.equal(evs.at(-1).event, 'series_started'); assert.equal(evs.at(-1).props.series_n, 2); assert.equal(evs.at(-1).props.previous_finished, true);
  // a series left in the middle, with a game running
  go(0, { k: 'next', from: null }); see();
  go(0, { k: 'newSeries', from: t.game.id, n: 2 }); see();
  assert.deepEqual(names().slice(-3), ['game_started', 'game_abandoned', 'series_started']);
  assert.equal(evs.at(-2).props.reason, 'new_series');
  go(0, { k: 'next', from: null }); see(); t = win(t, 1); see();
  go(0, { k: 'resetEvening' }); see();
  assert.deepEqual(names().slice(-2), ['series_abandoned', 'evening_reset']);
  // the guest's phone sees the same games, from its own side
  const g = gameEvents(clone(fresh()), clone(fresh()), 1);
  assert.deepEqual(g, [], 'a different room (other sid) never produces events');
  // every completed game counted once per phone
  assert.equal(evs.filter(e => e.event === 'game_completed').length, 7);
  for (const e of evs) { assert.ok(e.props.room_id); jsonSafe(e); }
  console.log('analytics: state changes → events checked (' + evs.length + ' events)');
}

console.log('logic tests passed ✔', counts, 'evening after 60 series:', s.evening);

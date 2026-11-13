// Run: node tests/logic.test.mjs
// Fuzzes the shared reducer and all five games: random legal play, garbage input, invariants.
import assert from 'node:assert/strict';
import { GAMES, BY, newState, reduce } from '../js/core.js';
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
  { k: 'pick' }, { k: 'pick', game: 'constructor' }, { k: 'pick', game: '__proto__' }, { k: 'nope' },
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
  { k: 'chat' }, { k: 'chat', text: '   ' }, { k: 'menu', from: 'wrong' }, { k: 'pick', game: 'bull', from: 'wrong' }, { k: 'g', gid: 'wrong', a: { k: 'put', i: 0 } },
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
    assert.ok(Math.abs(g.shots[0].length - g.shots[1].length) <= 1);
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
  let s = step(s0, ri(2), { k: 'pick', game: id, from: s0.game ? s0.game.id : null });
  assert.ok(s, 'pick works');
  const gid = s.game.id;
  const scoreBefore = clone(s.score);
  let guard = 0;
  while (!s.game.over) {
    assert.ok(++guard < 5000, id + ' never ends');
    if (guard % 7 === 0) garbage(s);
    const p = ri(2);
    const moves = legal[id](s.game, p);
    const turnOwner = legal[id](s.game, 0).length ? 0 : 1;
    if (!moves.length) {
      // not this player's turn: every move the other player could make must be refused for p
      for (const m of legal[id](s.game, 1 - p)) {
        if (m.k === 'secret' || m.k === 'word' || m.k === 'ready') continue; // simultaneous phases
        assert.equal(step(s, p, { k: 'g', gid, a: m }), null, `${id}: move out of turn accepted`);
      }
      continue;
    }
    void turnOwner;
    const m = moves[0];
    const n = step(s, p, { k: 'g', gid, a: m });
    if (!n) { assert.equal(id, 'ships', `${id}: legal move refused ${JSON.stringify(m)}`); continue; } // ships: random cell may be used
    // replaying the very same action must never be accepted twice in simultaneous-safe games
    s = n;
    jsonSafe(s);
    inv[id](s.game);
  }
  // exactly one score entry was added
  const w = s.game.over.winner;
  const exp = clone(scoreBefore); exp[id][w == null ? 2 : w]++;
  assert.deepEqual(s.score, exp, 'score counted exactly once');
  assert.equal(s.lastDone, id);
  // nothing can be played after the end
  for (const p of [0, 1]) for (const m of [...legal[id]({ ...s.game, over: null }, p)]) assert.equal(step(s, p, { k: 'g', gid, a: m }), null);
  garbage(s);
  return s;
}

// ---------- run ----------
let s = fresh();
garbage(s);
assert.equal(step(newState('A', 't'), 0, { k: 'pick', game: 'bull' }), null, 'cannot start before a partner joined');
assert.equal(step(s, 0, { k: 'menu' }), null, 'menu with no game is a no-op');

const counts = {};
for (let round = 0; round < 60; round++) {
  for (const G of GAMES) {
    s = playOne(G.id, s);
    counts[G.id] = (counts[G.id] || 0) + 1;
  }
}
const total = Object.values(s.score).flat().reduce((a, b) => a + b, 0);
assert.equal(total, 300);
for (const G of GAMES) assert.equal(s.score[G.id].reduce((a, b) => a + b, 0), 60);

// starter alternates
{
  let t = fresh();
  t = step(t, 0, { k: 'pick', game: 'dots' }); assert.equal(t.game.turn, 0);
  t = step(t, 0, { k: 'menu' });
  t = step(t, 0, { k: 'pick', game: 'dots' }); assert.equal(t.game.turn, 1);
  // two phones press "next game" at the same moment: only the first one counts
  const from = t.game.id;
  const a = step(t, 0, { k: 'pick', game: 'five', from });
  assert.ok(a);
  assert.equal(step(a, 1, { k: 'pick', game: 'five', from }), null);
  // a move made for the previous game is refused
  assert.equal(step(a, a.game.turn, { k: 'g', gid: from, a: { k: 'put', i: 5 } }), null);
  // leaving mid-game gives no score
  const b = step(a, 1, { k: 'menu', from: a.game.id });
  assert.deepEqual(b.score, t.score); assert.equal(b.leftBy, 1);
  // reset
  const c = step(s, 0, { k: 'resetScores' });
  assert.equal(Object.values(c.score).flat().reduce((x, y) => x + y, 0), 0);
}

// chat is capped and trimmed
{
  let t = fresh();
  for (let i = 0; i < 100; i++) t = step(t, i % 2, { k: 'chat', text: ' הודעה ' + i + ' '.repeat(300) + 'x'.repeat(400) });
  assert.equal(t.chat.length, 80);
  assert.ok(t.chat.every(m => m.text.length <= 240));
}

// specific rule checks
{
  // bull: bulls/hits counting
  let t = step(fresh(), 0, { k: 'pick', game: 'bull' });
  t = step(t, 0, { k: 'g', a: { k: 'secret', code: '0123' } });
  assert.equal(step(t, 0, { k: 'g', a: { k: 'secret', code: '4567' } }), null, 'secret cannot be changed');
  assert.equal(step(t, 0, { k: 'g', a: { k: 'guess', code: '4567' } }), null, 'no guessing before both chose');
  t = step(t, 1, { k: 'g', a: { k: 'secret', code: '4567' } });
  assert.equal(step(t, 1, { k: 'g', a: { k: 'guess', code: '0123' } }), null, 'not your turn');
  t = step(t, 0, { k: 'g', a: { k: 'guess', code: '4576' } }); assert.deepEqual([t.game.guesses[0][0].b, t.game.guesses[0][0].p], [2, 2]);
  t = step(t, 1, { k: 'g', a: { k: 'guess', code: '3210' } }); assert.deepEqual([t.game.guesses[1][0].b, t.game.guesses[1][0].p], [0, 4]);
  assert.equal(step(t, 0, { k: 'g', a: { k: 'guess', code: '4576' } }), null, 'same guess twice');
  t = step(t, 0, { k: 'g', a: { k: 'guess', code: '4567' } }); assert.equal(t.game.over, null, 'second player gets a last chance');
  t = step(t, 1, { k: 'g', a: { k: 'guess', code: '0123' } }); assert.deepEqual(t.game.over, { winner: null }); assert.equal(t.score.bull[2], 1);

  // hangman: finals count as regular letters, solve ignores spaces/case, 10 misses hang
  t = step(fresh(), 0, { k: 'pick', game: 'hangman' });
  t = step(t, 0, { k: 'g', a: { k: 'word', text: '  שלום   עולם ', lang: 'he' } }); assert.equal(t.game.words[0].text, 'שלום עולם');
  t = step(t, 1, { k: 'g', a: { k: 'word', text: 'ab c', lang: 'en' } }); assert.equal(t.game.words[1].text, 'AB C');
  t = step(t, 0, { k: 'g', a: { k: 'letter', l: 'a' } }); assert.equal(t.game.wrong[0], 0);
  t = step(t, 1, { k: 'g', a: { k: 'letter', l: 'מ' } }); assert.equal(t.game.wrong[1], 0, 'מ reveals ם');
  assert.equal(step(t, 0, { k: 'g', a: { k: 'letter', l: 'A' } }), null, 'letter already asked');
  assert.equal(step(t, 0, { k: 'g', a: { k: 'letter', l: 'ש' } }), null, 'hebrew letter on english word');
  t = step(t, 0, { k: 'g', a: { k: 'solve', text: 'abc' } }); assert.deepEqual(t.game.over, { winner: 0 });
  t = step(fresh(), 0, { k: 'pick', game: 'hangman' });
  t = step(t, 0, { k: 'g', a: { k: 'word', text: 'אב', lang: 'he' } });
  t = step(t, 1, { k: 'g', a: { k: 'word', text: 'גד', lang: 'he' } });
  const bad0 = 'הוזחטיכלמנ'.split(''), bad1 = 'סעפצקרשתהו'.split('');
  for (let i = 0; i < 10 && !t.game.over; i++) { t = step(t, 0, { k: 'g', a: { k: 'letter', l: bad0[i] } }); if (!t.game.over) t = step(t, 1, { k: 'g', a: { k: 'letter', l: bad1[i] } }); }
  assert.deepEqual(t.game.over, { winner: 1, hanged: 0 });

  // dots: closing a box gives another turn
  t = step(fresh(), 0, { k: 'pick', game: 'dots' });
  const L = (p, o, r, c) => { const n = step(t, p, { k: 'g', a: { k: 'line', o, r, c } }); assert.ok(n, `line ${o}${r}${c} by ${p}`); t = n; };
  L(0, 'h', 0, 0); L(1, 'h', 1, 0); L(0, 'v', 0, 0); L(1, 'v', 0, 1);
  assert.equal(t.game.box[0][0], 1); assert.equal(t.game.turn, 1, 'extra turn after closing');
  assert.equal(step(t, 1, { k: 'g', a: { k: 'line', o: 'h', r: 0, c: 0 } }), null, 'line already drawn');
  // one line closing two boxes
  L(1, 'h', 0, 1); L(0, 'h', 1, 1); L(1, 'v', 0, 2); assert.equal(t.game.box[0][1], 1); assert.equal(t.game.turn, 1);

  // ships: touching layouts are refused, sinking marks neighbours
  const bad = [{ id: 'nun', cells: [[0, 0], [0, 1], [1, 0], [2, 0], [3, 0]] }, { id: 's4', cells: [[1, 1], [1, 2], [1, 3], [1, 4]] }, { id: 's3', cells: [[5, 0], [5, 1], [5, 2]] }, { id: 's2', cells: [[5, 4], [5, 5]] }];
  assert.equal(validLayout(bad), false, 'diagonal touch refused');
  const good = [{ id: 'nun', cells: [[0, 0], [0, 1], [1, 0], [2, 0], [3, 0]] }, { id: 's4', cells: [[2, 2], [2, 3], [2, 4], [2, 5]] }, { id: 's3', cells: [[5, 0], [5, 1], [5, 2]] }, { id: 's2', cells: [[4, 4], [5, 4]] }];
  assert.equal(validLayout(good), true);
  assert.equal(validLayout([...good.slice(0, 3), { id: 's2', cells: [[4, 4], [5, 5]] }]), false, 'bent ship refused');
  assert.equal(validLayout([...good.slice(0, 3), { id: 's2', cells: [[4, 5], [4, 6]] }]), false, 'outside board refused');
  assert.equal(validLayout([good[0], good[1], good[2], good[2]]), false);
  t = step(fresh(), 0, { k: 'pick', game: 'ships' });
  assert.equal(step(t, 0, { k: 'g', a: { k: 'ready', ships: bad } }), null);
  t = step(t, 0, { k: 'g', a: { k: 'ready', ships: good } });
  t = step(t, 1, { k: 'g', a: { k: 'ready', ships: good } });
  t = step(t, 0, { k: 'g', a: { k: 'shot', r: 4, c: 4 } }); assert.equal(t.game.last.res, 'hit');
  t = step(t, 1, { k: 'g', a: { k: 'shot', r: 0, c: 5 } }); assert.equal(t.game.last.res, 'miss');
  t = step(t, 0, { k: 'g', a: { k: 'shot', r: 5, c: 4 } }); assert.equal(t.game.last.res, 'sunk');
  t = step(t, 1, { k: 'g', a: { k: 'shot', r: 1, c: 5 } });
  assert.equal(step(t, 0, { k: 'g', a: { k: 'shot', r: 5, c: 5 } }), null, 'cell next to a sunk sub is known to be empty');
  assert.equal(step(t, 0, { k: 'g', a: { k: 'shot', r: 4, c: 4 } }), null, 'already shot');

  // five: exactly five, diagonals, edges do not wrap
  t = step(fresh(), 0, { k: 'pick', game: 'five' });
  const P = (p, r, c) => { const n = step(t, p, { k: 'g', a: { k: 'put', i: r * 21 + c } }); assert.ok(n); t = n; };
  // four at the end of one row + one at the start of the next row must NOT win
  P(0, 0, 17); P(1, 5, 5); P(0, 0, 18); P(1, 5, 7); P(0, 0, 19); P(1, 5, 9); P(0, 0, 20); P(1, 5, 11); P(0, 1, 0);
  assert.equal(t.game.over, null, 'rows do not wrap around the edge');
  P(1, 9, 9); P(0, 4, 20); P(1, 9, 11); P(0, 3, 20); P(1, 9, 13); P(0, 2, 20); P(1, 12, 12); P(0, 1, 20);
  assert.deepEqual(t.game.over, { winner: 0 }, 'vertical five on the edge');
  t = step(fresh(), 0, { k: 'pick', game: 'five' });
  P(0, 10, 10); P(1, 0, 0); P(0, 9, 11); P(1, 0, 2); P(0, 8, 12); P(1, 0, 4); P(0, 6, 14); P(1, 0, 6); P(0, 7, 13);
  assert.deepEqual(t.game.over, { winner: 0 }, 'anti-diagonal, filled in the middle');
  assert.deepEqual(t.game.line, [6 * 21 + 14, 10 * 21 + 10]);
}

console.log('logic tests passed ✔', counts);

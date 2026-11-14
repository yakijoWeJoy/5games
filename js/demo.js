/* Canned screens for visual testing in any browser (?demo=<scene>&me=0|1). No network involved. */
import { newState, reduce, GAMES } from './core.js';
import { SHIPS } from './games/ships.js';

const LAYOUT = [
  { id: 'nun', cells: [[0, 0], [0, 1], [1, 0], [2, 0], [3, 0]] }, { id: 's4', cells: [[2, 2], [2, 3], [2, 4], [2, 5]] },
  { id: 's3', cells: [[5, 0], [5, 1], [5, 2]] }, { id: 's2', cells: [[4, 4], [5, 4]] },
];
const SHIP_CELLS = LAYOUT.flatMap(s => s.cells);

function mk() {
  const s = newState('אבא', 't0');
  s.players[1] = { name: 'נועה', token: 't1' };
  return s;
}
const A = (s, p, a) => { if (!reduce(s, p, a, { test: true })) throw new Error('demo action refused: ' + JSON.stringify(a)); };
const G = (s, p, a) => A(s, p, { k: 'g', a });

/** play the current game to its end so that `w` wins (dots: whoever) */
function finish(s, w) {
  const g = () => s.game;
  switch (s.current) {
    case 'bull': {
      G(s, 0, { k: 'secret', code: '1234' }); G(s, 1, { k: 'secret', code: '5678' });
      const secret = p => (p === 0 ? '5678' : '1234');
      const first = g().turn;
      G(s, first, { k: 'guess', code: first === w ? secret(first) : '9012' });
      if (!g().over) G(s, 1 - first, { k: 'guess', code: 1 - first === w ? secret(1 - first) : '9013' });
      break;
    }
    case 'hangman': {
      G(s, 0, { k: 'word', text: 'גלידה', lang: 'he', hint: 'קר ומתוק' }); G(s, 1, { k: 'word', text: 'חתול', lang: 'he' });
      if (g().turn !== w) G(s, g().turn, { k: 'letter', l: 'ק' });
      for (const l of (w === 0 ? 'חתול' : 'גלידה')) if (!g().over) G(s, w, { k: 'letter', l });
      break;
    }
    case 'ships': {
      G(s, 0, { k: 'ready', ships: LAYOUT }); G(s, 1, { k: 'ready', ships: LAYOUT });
      if (g().turn !== w) G(s, g().turn, { k: 'shot', r: 0, c: 5 });
      for (const [r, c] of SHIP_CELLS) if (!g().over) G(s, w, { k: 'shot', r, c });
      break;
    }
    case 'dots': {
      for (let r = 0; r < 6; r++) for (let c = 0; c < 5; c++) if (!g().over) G(s, g().turn, { k: 'line', o: 'h', r, c });
      for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) if (!g().over) G(s, g().turn, { k: 'line', o: 'v', r, c });
      break;
    }
    case 'five': {
      let k = 0;
      while (!g().over) {
        const p = g().turn;
        G(s, p, { k: 'put', i: p === w ? 10 * 21 + 8 + Math.floor(k / 2) : 3 * 21 + 2 * Math.floor(k / 2) + (k % 2) * 0 + 1 + k });
        k++;
      }
      break;
    }
  }
}
function playSeries(s, winners) {
  for (const w of winners) { A(s, 0, { k: 'next' }); finish(s, w); }
}

const SCENES = {
  home: () => ({ home: true }),
  join: () => ({ home: true, room: '4821' }),
  invite: () => { const s = newState('אבא', 't0'); return { state: s }; },
  menu: () => ({ state: mk() }),
  'menu-mid': () => { const s = mk(); playSeries(s, [0, 1]); A(s, 0, { k: 'menu' }); return { state: s }; },
  'bull-secret': () => { const s = mk(); A(s, 0, { k: 'next' }); return { state: s }; },
  'bull-play': () => {
    const s = mk(); A(s, 0, { k: 'next' });
    G(s, 0, { k: 'secret', code: '1234' }); G(s, 1, { k: 'secret', code: '5678' });
    const codes = [['5612', '9087'], ['1243', '4321']];
    for (let i = 0; i < 2; i++) for (let k = 0; k < 2; k++) { const p = s.game.turn; G(s, p, { k: 'guess', code: codes[p][i] }); }
    return { state: s };
  },
  'bull-over': () => { const s = mk(); playSeries(s, [0]); return { state: s }; },
  'hangman-word': () => { const s = mk(); playSeries(s, [0]); A(s, 0, { k: 'next' }); return { state: s }; },
  'hangman-play': () => {
    const s = mk(); playSeries(s, [0]); A(s, 0, { k: 'next' });
    G(s, 0, { k: 'word', text: 'גלידה', lang: 'he', hint: 'קר ומתוק' }); G(s, 1, { k: 'word', text: 'ICE CREAM', lang: 'en' });
    const moves = { 0: ['E', 'Z', 'Q', 'X'], 1: ['ל', 'ק', 'ש', 'ר'] };
    const idx = [0, 0];
    for (let n = 0; n < 6; n++) { const p = s.game.turn; G(s, p, { k: 'letter', l: moves[p][idx[p]++] }); }
    return { state: s };
  },
  'ships-place': () => { const s = mk(); playSeries(s, [0, 1]); A(s, 0, { k: 'next' }); return { state: s }; },
  'ships-play': () => {
    const s = mk(); playSeries(s, [0, 1]); A(s, 0, { k: 'next' });
    G(s, 0, { k: 'ready', ships: LAYOUT }); G(s, 1, { k: 'ready', ships: LAYOUT });
    const shots = { 0: [[4, 4], [5, 4], [1, 3], [0, 0], [0, 3]], 1: [[2, 2], [2, 3], [0, 4], [5, 5], [1, 1]] };
    const idx = [0, 0];
    for (let n = 0; n < 9; n++) { const p = s.game.turn; const sh = shots[p][idx[p]++]; if (!sh) break; G(s, p, { k: 'shot', r: sh[0], c: sh[1] }); }
    return { state: s };
  },
  dots: () => {
    const s = mk(); playSeries(s, [0, 1, 0]); A(s, 0, { k: 'next' });
    const seq = [['h', 0, 0], ['h', 1, 0], ['v', 0, 0], ['v', 0, 1], ['h', 0, 1], ['h', 1, 1], ['v', 0, 2], ['h', 3, 3], ['v', 3, 3], ['v', 3, 4], ['h', 4, 3], ['h', 2, 1], ['v', 2, 4], ['h', 5, 0], ['v', 4, 0]];
    for (const [o, r, c] of seq) G(s, s.game.turn, { k: 'line', o, r, c });
    return { state: s };
  },
  five: () => {
    const s = mk(); playSeries(s, [0, 1, 0, 1]); A(s, 0, { k: 'next' });
    const seq = [[10, 10], [10, 11], [9, 11], [11, 9], [8, 12], [9, 10], [11, 11], [12, 12], [9, 12], [9, 13]];
    for (const [r, c] of seq) G(s, s.game.turn, { k: 'put', i: r * 21 + c });
    return { state: s };
  },
  'five-many': () => {
    // lots of marks all over the sheet (never five in a row): shows that every mark sits inside its square
    const s = mk(); playSeries(s, [0, 1, 0, 1]); A(s, 0, { k: 'next' });
    const cells = [];
    for (let r = 4; r < 17; r++) for (let c = 4; c < 17; c++) if ((r * 3 + c * 5) % 4 < 2) cells.push([r, c]);
    const a = cells.filter(([r, c]) => (r + Math.floor(c / 2)) % 2 === 0), b = cells.filter(([r, c]) => (r + Math.floor(c / 2)) % 2 === 1);
    for (let i = 0; i < Math.min(a.length, b.length) && !s.game.over; i++) { G(s, s.game.turn, { k: 'put', i: a[i][0] * 21 + a[i][1] }); if (!s.game.over) G(s, s.game.turn, { k: 'put', i: b[i][0] * 21 + b[i][1] }); }
    return { state: s };
  },
  'five-over': () => { const s = mk(); playSeries(s, [0, 1, 0, 1, 1]); return { state: s }; },
  decided: () => { const s = mk(); playSeries(s, [1, 1, 1]); return { state: s }; },
  'decided-menu': () => { const s = mk(); playSeries(s, [0, 0, 0]); A(s, 0, { k: 'menu' }); return { state: s }; },
  'done-menu': () => {
    const s = mk(); playSeries(s, [0, 1, 0, 1, 0]); A(s, 0, { k: 'newSeries' });
    playSeries(s, [1, 1, 0, 0, 1]); A(s, 0, { k: 'menu' });
    return { state: s };
  },
  lost: () => { const d = SCENES['ships-play'](); d.link = 'no-host'; return d; },
};

export function demoState(name) {
  const f = SCENES[name] || SCENES.menu;
  return f();
}
export const DEMO_SCENES = Object.keys(SCENES);
void GAMES; void SHIPS;

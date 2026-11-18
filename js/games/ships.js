import { h, s, toast, markX, markDot, INK } from '../ui.js';

export const N = 6;
const COLS = 'אבגדהו';
export const SHIPS = [
  { id: 'nun', name: 'ן', size: 5, cells: [[0, 0], [0, 1], [1, 0], [2, 0], [3, 0]] },
  { id: 's4', name: 'צוללת 4', size: 4, cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },
  { id: 's3', name: 'צוללת 3', size: 3, cells: [[0, 0], [0, 1], [0, 2]] },
  { id: 's2', name: 'צוללת 2', size: 2, cells: [[0, 0], [0, 1]] },
];
const DEF = Object.fromEntries(SHIPS.map(d => [d.id, d]));
const coord = (r, c) => `${COLS[c]}${r + 1}`;

function norm(cells) {
  const mr = Math.min(...cells.map(c => c[0])), mc = Math.min(...cells.map(c => c[1]));
  return cells.map(([r, c]) => [r - mr, c - mc]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
export function orient(cells, rot, flip) {
  let cs = cells.map(([r, c]) => [r, flip ? -c : c]);
  for (let i = 0; i < rot; i++) cs = cs.map(([r, c]) => [c, -r]);
  return norm(cs);
}
const key = cs => norm(cs).map(x => x.join(',')).join(';');
const ORIENTS = Object.fromEntries(SHIPS.map(d => {
  const set = new Set();
  for (const f of [0, 1]) for (let r = 0; r < 4; r++) set.add(key(orient(d.cells, r, f)));
  return [d.id, set];
}));
const inBoard = ([r, c]) => Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < N && c >= 0 && c < N;
const touches = (a, b) => a.some(([r1, c1]) => b.some(([r2, c2]) => Math.abs(r1 - r2) <= 1 && Math.abs(c1 - c2) <= 1));

/** can `cells` be added next to the already placed ships (map id->cells)? */
export function fits(placed, cells, exceptId) {
  if (!cells.every(inBoard)) return false;
  return Object.entries(placed).every(([id, cs]) => id === exceptId || !touches(cs, cells));
}

export function validLayout(layout) {
  if (!Array.isArray(layout) || layout.length !== SHIPS.length) return false;
  const placed = {};
  for (const d of SHIPS) {
    const sh = layout.find(x => x && x.id === d.id);
    if (!sh || !Array.isArray(sh.cells) || sh.cells.length !== d.size) return false;
    if (!sh.cells.every(c => Array.isArray(c) && inBoard(c))) return false;
    if (!ORIENTS[d.id].has(key(sh.cells))) return false;
    if (!fits(placed, sh.cells)) return false;
    placed[d.id] = sh.cells;
  }
  return true;
}

const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
export function randomLayout() {
  const opts = d => {
    const out = [];
    for (const f of [0, 1]) for (let r = 0; r < 4; r++) {
      const cs = orient(d.cells, r, f);
      for (let dr = 0; dr < N; dr++) for (let dc = 0; dc < N; dc++) {
        const moved = cs.map(([a, b]) => [a + dr, b + dc]);
        if (moved.every(inBoard)) out.push(moved);
      }
    }
    return shuffle(out);
  };
  const placed = {};
  const go = i => {
    if (i === SHIPS.length) return true;
    const d = SHIPS[i];
    for (const cs of opts(d)) {
      if (!fits(placed, cs)) continue;
      placed[d.id] = cs;
      if (go(i + 1)) return true;
      delete placed[d.id];
    }
    return false;
  };
  go(0);
  return placed;
}

const shipAt = (layout, r, c) => layout.find(sh => sh.cells.some(([a, b]) => a === r && b === c));
function autoCells(g, p) {
  // cells around a sunk ship are known to be empty (ships never touch)
  const out = new Set();
  for (const id of g.sunk[p]) {
    const sh = g.layouts[1 - p].find(x => x.id === id);
    for (const [r, c] of sh.cells) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (inBoard([rr, cc]) && !shipAt([sh], rr, cc)) out.add(rr * N + cc);
    }
  }
  return out;
}

let ui = { id: null };
function sync(g) {
  if (ui.id !== g.id) ui = { id: g.id, placed: {}, sel: 'nun', rot: 0, flip: 0, aim: null };
}

function cellSvg(kind, color) {
  const svg = s('svg', { viewBox: '0 0 40 40' });
  if (kind === 'miss') svg.append(markDot(20, 20, 4, color));
  if (kind === 'auto') svg.append(markDot(20, 20, 2.4, '#9a958a'));
  if (kind === 'hit') svg.append(markX(20, 20, 11, color, 3.4));
  if (kind === 'aim') svg.append(s('circle', { cx: 20, cy: 20, r: 13, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-dasharray': '4 3' }));
  return svg;
}

function board({ small = false, cellInfo, onCell, enabled }) {
  const b = h('div', { class: 'board' + (small ? ' small' : '') });
  b.append(h('div', {}));
  for (let c = 0; c < N; c++) b.append(h('div', { class: 'lbl' }, COLS[c]));
  for (let r = 0; r < N; r++) {
    b.append(h('div', { class: 'lbl' }, r + 1));
    for (let c = 0; c < N; c++) {
      const info = cellInfo(r, c);
      const on = !!(enabled && enabled(r, c));
      // a plain div (not a <button>): phone browsers paint the marks inside it reliably
      const el = h('div', {
        class: 'cell ' + (info.cls || '') + (on ? ' hot' : ''),
        role: 'button', 'aria-label': coord(r, c), 'aria-disabled': on ? null : 'true', tabindex: on ? 0 : null,
        onclick: on && onCell ? () => onCell(r, c) : null,
      });
      if (info.mark) el.append(cellSvg(info.mark, info.color));
      b.append(el);
    }
  }
  return b;
}

function shipIcon(d, rot = 0, flip = 0, on = false) {
  const cs = orient(d.cells, rot, flip);
  const R = Math.max(...cs.map(c => c[0])) + 1, C = Math.max(...cs.map(c => c[1])) + 1;
  const u = 11;
  const svg = s('svg', { width: C * u + 2, height: R * u + 2, viewBox: `-1 -1 ${C * u + 2} ${R * u + 2}`, style: 'direction:ltr' });
  for (const [r, c] of cs) {
    // columns are drawn right-to-left like on the board
    svg.append(s('rect', { x: (C - 1 - c) * u, y: r * u, width: u, height: u, fill: '#3b3a36', 'fill-opacity': .28, stroke: '#3b3a36', 'stroke-width': 1.2 }));
  }
  return svg;
}

export default {
  id: 'ships',
  title: 'צוללות',
  sub: 'לוח 6×6 · צוללות 2, 3, 4 וצוללת ן · אסור שייגעו',
  help: [
    'כל אחד מסדר 4 צוללות על הלוח שלו: 2, 3, 4 משבצות וצוללת בצורת ן. צוללות לא נוגעות זו בזו, גם לא באלכסון.',
    'יורים בתורות על הלוח של השני: לחיצה בוחרת משבצת, לחיצה שנייה יורה.',
    'פגיעה = <b>עוד ירייה</b>. החטאה = התור עובר.',
    'מי שמטביע ראשון את כל הצוללות של השני מנצח.',
  ],

  init(starter) {
    return { starter, turn: starter, phase: 'place', layouts: [null, null], shots: [[], []], sunk: [[], []], last: null, over: null };
  },

  apply(g, a, p) {
    if (a.k === 'ready') {
      if (g.phase !== 'place' || g.layouts[p] || !validLayout(a.ships)) return false;
      g.layouts[p] = SHIPS.map(d => ({ id: d.id, cells: a.ships.find(x => x.id === d.id).cells }));
      if (g.layouts[0] && g.layouts[1]) g.phase = 'play';
      return true;
    }
    if (a.k === 'shot') {
      const { r, c } = a;
      if (g.phase !== 'play' || g.turn !== p || !inBoard([r, c])) return false;
      if (g.shots[p].some(x => x.r === r && x.c === c) || autoCells(g, p).has(r * N + c)) return false;
      const sh = shipAt(g.layouts[1 - p], r, c);
      let res = 'miss';
      g.shots[p].push({ r, c });
      if (sh) {
        res = 'hit';
        if (sh.cells.every(([a2, b2]) => g.shots[p].some(x => x.r === a2 && x.c === b2))) {
          res = 'sunk';
          g.sunk[p].push(sh.id);
        }
      }
      g.shots[p][g.shots[p].length - 1].res = res;
      g.last = { p, r, c, res, ship: res === 'sunk' ? sh.id : null };
      if (g.sunk[p].length === SHIPS.length) { g.over = { winner: p }; return true; }
      if (res === 'miss') g.turn = 1 - p; // a hit earns another shot
      return true;
    }
    return false;
  },

  status(g, { me, other, names }) {
    if (g.phase === 'place') {
      return g.layouts[me]
        ? { mine: false, text: `מחכים ש${names[other]} יסדר/תסדר את הצוללות…` }
        : { mine: true, text: 'מסדרים את הצוללות 🚢' };
    }
    let t = '';
    if (g.last) {
      // short enough for two lines on the smallest phones
      const who = g.last.p === me ? 'ירית ב' : `${names[other]}: `;
      const res = g.last.res === 'sunk' ? `טביעה! ${DEF[g.last.ship].name} 🌊` : g.last.res === 'hit' ? 'פגיעה! 💥' : 'החטאה';
      t = `${who}${coord(g.last.r, g.last.c)} – ${res} · `;
    }
    const again = g.last && g.last.res !== 'miss';
    if (g.turn === me) return { mine: true, text: t + (again ? 'עוד תור! 🎯' : 'תורך! 🎯') };
    return { mine: false, text: t + (again ? `${names[other]} ממשיך/ה…` : `התור של ${names[other]}`) };
  },

  overDetail(g, { me }) {
    return g.over.winner === me ? 'כל הצוללות שלהם בקרקעית 🌊' : 'כל הצוללות שלך טבעו… 🫧';
  },

  render(root, g, ctx) {
    root.replaceChildren();
    sync(g);
    const { me, other, names, send } = ctx;
    const myInk = INK[me], theirInk = INK[other];
    const rerender = () => { root.replaceChildren(); this.render(root, g, ctx); };

    if (g.phase === 'place') {
      if (g.layouts[me]) {
        const mine = g.layouts[me];
        root.append(h('h3', { class: 'center' }, 'הצוללות שלי'), board({
          cellInfo: (r, c) => ({ cls: shipAt(mine, r, c) ? 'ship' : '' }),
        }));
        return;
      }
      const placedIds = Object.keys(ui.placed);
      const owner = (r, c) => Object.entries(ui.placed).find(([, cs]) => cs.some(([a, b]) => a === r && b === c));
      const nextUnplaced = () => (SHIPS.find(d => !ui.placed[d.id]) || {}).id || null;

      root.append(h('p', { class: 'center soft', style: { margin: '2px 0' } },
        'בוחרים צוללת ולוחצים על הלוח. לחיצה על צוללת מרימה אותה. צוללות לא נוגעות – גם לא באלכסון.'));
      root.append(h('div', { class: 'tray' }, SHIPS.map(d => h('button', {
        class: (ui.sel === d.id ? 'on' : '') + (ui.placed[d.id] ? ' placed' : ''),
        onclick: () => { delete ui.placed[d.id]; ui.sel = d.id; rerender(); },
      }, shipIcon(d, ui.sel === d.id ? ui.rot : 0, ui.sel === d.id ? ui.flip : 0), h('div', { style: { fontSize: '13px' } }, d.name)))));

      root.append(board({
        cellInfo: (r, c) => ({ cls: owner(r, c) ? 'ship' : '' }),
        enabled: () => true,
        onCell: (r, c) => {
          const o = owner(r, c);
          if (o) { delete ui.placed[o[0]]; ui.sel = o[0]; rerender(); return; }
          if (!ui.sel) return;
          let cs = orient(DEF[ui.sel].cells, ui.rot, ui.flip).map(([a, b]) => [a + r, b + c]);
          const or = Math.max(0, Math.max(...cs.map(x => x[0])) - (N - 1));
          const oc = Math.max(0, Math.max(...cs.map(x => x[1])) - (N - 1));
          cs = cs.map(([a, b]) => [a - or, b - oc]);
          if (!fits(ui.placed, cs)) { toast('אסור שצוללות ייגעו זו בזו (גם לא באלכסון)'); return; }
          ui.placed[ui.sel] = cs;
          ui.sel = nextUnplaced();
          rerender();
        },
      }));
      const all = placedIds.length === SHIPS.length;
      root.append(h('div', { class: 'row center' },
        h('button', { class: 'btn small', disabled: !ui.sel, onclick: () => { ui.rot = (ui.rot + 1) % 4; rerender(); } }, '↻ סיבוב'),
        ui.sel === 'nun' ? h('button', { class: 'btn small', onclick: () => { ui.flip = 1 - ui.flip; rerender(); } }, '⇋ היפוך') : null,
        h('button', { class: 'btn small', onclick: () => { ui.placed = randomLayout(); ui.sel = null; rerender(); } }, '🎲 אקראי'),
        h('button', { class: 'btn small ghost', onclick: () => { ui.placed = {}; ui.sel = 'nun'; rerender(); } }, 'ניקוי')));
      root.append(h('div', { class: 'spacer' }), h('button', {
        class: 'btn big marker', disabled: !all,
        onclick: () => send({ k: 'ready', ships: SHIPS.map(d => ({ id: d.id, cells: ui.placed[d.id] })) }),
      }, all ? 'מוכן! ⚓' : `נשארו ${SHIPS.length - placedIds.length} צוללות`));
      return;
    }

    // ----- battle -----
    const myTurn = g.turn === me && !g.over;
    const auto = autoCells(g, me);
    const shotAt = (list, r, c) => list.find(x => x.r === r && x.c === c);
    const enemy = g.layouts[other];
    const sunkCells = new Set(g.sunk[me].flatMap(id => enemy.find(x => x.id === id).cells.map(([r, c]) => r * N + c)));
    if (ui.aim && (shotAt(g.shots[me], ui.aim.r, ui.aim.c) || auto.has(ui.aim.r * N + ui.aim.c))) ui.aim = null;

    root.append(h('h3', { class: 'center', style: { color: theirInk } }, `הים של ${names[other]}`));
    root.append(h('div', { class: 'fleet' }, SHIPS.map(d => h('span', { class: g.sunk[me].includes(d.id) ? 'sunk' : '' }, d.name))));
    root.append(board({
      cellInfo: (r, c) => {
        const sh = shotAt(g.shots[me], r, c);
        const last = g.last && g.last.p === me && g.last.r === r && g.last.c === c ? ' last' : '';
        if (ui.aim && ui.aim.r === r && ui.aim.c === c) return { cls: 'sel', mark: 'aim', color: myInk };
        if (sh) return { cls: (sunkCells.has(r * N + c) ? 'sunk' : '') + last, mark: sh.res === 'miss' ? 'miss' : 'hit', color: myInk };
        if (g.over && shipAt(enemy, r, c)) return { cls: 'ship' };
        if (auto.has(r * N + c)) return { mark: 'auto' };
        return {};
      },
      enabled: (r, c) => myTurn && !shotAt(g.shots[me], r, c) && !auto.has(r * N + c),
      onCell: (r, c) => {
        if (ui.aim && ui.aim.r === r && ui.aim.c === c) { ui.aim = null; send({ k: 'shot', r, c }); return; }
        ui.aim = { r, c }; rerender();
      },
    }));
    if (!g.over) {
      // the button always keeps its place, so the boards do not move when the turn changes
      root.append(h('div', { class: 'center' }, h('button', {
        class: 'btn marker', disabled: !myTurn || !ui.aim, 'data-log': 'fire',
        onclick: () => { const { r, c } = ui.aim; ui.aim = null; send({ k: 'shot', r, c }); },
      }, !myTurn ? `מחכים ל${names[other]}…` : ui.aim ? `אש על ${coord(ui.aim.r, ui.aim.c)}! 💥` : 'בוחרים משבצת לירות')));
    }

    const mine = g.layouts[me];
    root.append(h('hr', { class: 'pencil-line' }), h('h3', { class: 'center', style: { color: myInk } }, 'הים שלי'));
    root.append(board({
      small: true,
      cellInfo: (r, c) => {
        const sh = shotAt(g.shots[other], r, c);
        const onShip = shipAt(mine, r, c);
        const last = g.last && g.last.p === other && g.last.r === r && g.last.c === c ? ' last' : '';
        const sunk = onShip && g.sunk[other].includes(onShip.id);
        return { cls: (onShip ? (sunk ? 'sunk' : 'ship') : '') + last, mark: sh ? (sh.res === 'miss' ? 'miss' : 'hit') : null, color: theirInk };
      },
    }));
  },
};

import { h, s, markX, markO, roughLine, INK } from '../ui.js';
import { log } from '../log.js';
import { T } from '../i18n.js';

const N = 21;      // a big sheet of squared paper
const U = 30;      // drawing units per square
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
export const FIVE = { N, U, MARK_X: U * .27, MARK_O: U * .3 }; // mark sizes: always well inside the square
const { MARK_X, MARK_O } = FIVE;

// The board element lives as long as the game does: taps only redraw the marks, so the sheet never
// jumps or loses its scroll position under the finger.
let ui = { id: null };
let dom = null;

export default {
  id: 'five',
  title: T('5 בשורה', 'Five in a Row'),
  sub: T('דף משבצות ענק · הראשון שמשלים 5 ברצף', 'A huge squared sheet · first to get 5 in a row'),
  help: [
    T('מסמנים בתורות: אחד ✕ והשני ◯.', 'Take turns marking: one plays ✕, the other ◯.'),
    T('הראשון שמשלים <b>5 ברצף</b> – בשורה, בטור או באלכסון – מנצח.', 'First to get <b>5 in a row</b> – across, down or diagonally – wins.'),
    T('לחיצה אחת בוחרת משבצת, לחיצה שנייה מסמנת (כדי שלא יהיו טעויות).', 'One tap picks a square, a second tap marks it (so there are no mistakes).'),
    T('הדף גדול: גוללים עם האצבע, ו-+ / − מגדילים ומקטינים.', 'The sheet is big: scroll with your finger, and use + / − to zoom.'),
  ],

  init(starter) {
    return { starter, turn: starter, cells: Array(N * N).fill(-1), last: null, line: null, over: null };
  },

  apply(g, a, p) {
    const i = a.i;
    if (a.k !== 'put' || g.turn !== p || !Number.isInteger(i) || i < 0 || i >= N * N || g.cells[i] !== -1) return false;
    g.cells[i] = p;
    g.last = i;
    const r = Math.floor(i / N), c = i % N;
    for (const [dr, dc] of DIRS) {
      const run = [i];
      for (const sgn of [1, -1]) {
        let rr = r + dr * sgn, cc = c + dc * sgn;
        while (rr >= 0 && rr < N && cc >= 0 && cc < N && g.cells[rr * N + cc] === p) {
          run.push(rr * N + cc); rr += dr * sgn; cc += dc * sgn;
        }
      }
      if (run.length >= 5) {
        run.sort((x, y) => x - y);
        g.line = [run[0], run[run.length - 1]];
        g.over = { winner: p };
        return true;
      }
    }
    if (g.cells.every(x => x >= 0)) { g.over = { winner: null }; return true; }
    g.turn = 1 - p;
    return true;
  },

  status(g, { me, other, names }) {
    const sym = g.turn === 0 ? '✕' : '◯';
    return g.turn === me
      ? { mine: true, text: T(`תורך לסמן ${sym}`, `Your turn to mark ${sym}`) }
      : { mine: false, text: T(`התור של ${names[other]}…`, `${names[other]}\'s turn…`) };
  },

  overDetail(g, { me }) {
    return g.over.winner == null ? T('הדף התמלא!', 'The sheet is full!') : g.over.winner === me ? T('חמש בשורה! ✋', 'Five in a row! ✋') : T('חמש בשורה… בפעם הבאה 💪', 'Five in a row… next time 💪');
  },

  render(root, g, ctx) {
    if (ui.id !== g.id) ui = { id: g.id, sel: null, cell: ui.cell || 30, seenLast: undefined };
    if (!dom || dom.id !== g.id || dom.root !== root || !root.contains(dom.wrap)) dom = build(root, g.id);
    dom.g = g; dom.ctx = ctx;
    paint();
  },
};

function build(root, id) {
  root.replaceChildren();
  const d = { id, root };
  d.svg = s('svg', { viewBox: `0 0 ${N * U} ${N * U}` });
  d.board = h('div', { class: 'five-board' }, d.svg);
  d.wrap = h('div', { class: 'five-wrap' }, d.board);
  d.names = h('span', {});
  d.confirm = h('button', { class: 'btn marker', 'data-log': 'five-confirm', onclick: () => { if (ui.sel != null) place(ui.sel); } });
  d.confirmRow = h('div', { class: 'center' }, d.confirm);
  const zoom = by => {
    const w = d.wrap, old = ui.cell;
    const cx = (w.scrollLeft + w.clientWidth / 2) / old, cy = (w.scrollTop + w.clientHeight / 2) / old;
    ui.cell = Math.max(20, Math.min(46, ui.cell + by));
    paint();
    w.scrollLeft = cx * ui.cell - w.clientWidth / 2; w.scrollTop = cy * ui.cell - w.clientHeight / 2;
  };
  root.append(
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      d.names,
      h('div', { class: 'zoom' },
        h('button', { class: 'btn small', 'data-log': 'zoom-out', onclick: () => zoom(-4) }, '−'),
        h('button', { class: 'btn small', 'data-log': 'zoom-in', onclick: () => zoom(4) }, '+'))),
    d.wrap, d.confirmRow);

  d.board.addEventListener('click', e => {
    const g = d.g, ctx = d.ctx;
    if (!g || g.over || g.turn !== ctx.me) return;
    // measure the sheet as it is really drawn on this screen
    const rect = d.board.getBoundingClientRect();
    const cell = rect.width / N;
    const c = Math.floor((e.clientX - rect.left) / cell), r = Math.floor((e.clientY - rect.top) / cell);
    log('five-tap', { r, c, cell: +cell.toFixed(2), set: ui.cell, x: Math.round(e.clientX - rect.left), y: Math.round(e.clientY - rect.top), dpr: window.devicePixelRatio, vv: window.visualViewport ? +window.visualViewport.scale.toFixed(2) : 1 });
    if (r < 0 || r >= N || c < 0 || c >= N) return;
    const i = r * N + c;
    if (g.cells[i] !== -1) return;
    if (ui.sel === i) { place(i); return; }
    ui.sel = i;
    paint();
  });
  return d;
}

function place(i) {
  ui.sel = null;
  dom.ctx.send({ k: 'put', i });
  paint();
}

function paint() {
  const d = dom, g = d.g, ctx = d.ctx, me = ctx.me;
  const myTurn = g.turn === me && !g.over;
  if (ui.sel != null && (g.cells[ui.sel] !== -1 || !myTurn)) ui.sel = null;
  const cell = ui.cell, px = N * cell;
  Object.assign(d.board.style, {
    width: px + 'px', height: px + 'px',
    backgroundImage: 'linear-gradient(rgba(70,120,190,.38) 1px, transparent 1px), linear-gradient(90deg, rgba(70,120,190,.38) 1px, transparent 1px)',
    backgroundSize: `${cell}px ${cell}px`,
    backgroundColor: '#fdfcf6', // opaque: the notebook grid of the page must not show through the sheet
  });
  d.svg.setAttribute('width', px); d.svg.setAttribute('height', px);

  const center = i => [(i % N) * U + U / 2, Math.floor(i / N) * U + U / 2];
  const mark = (i, p, op) => {
    const [x, y] = center(i);
    const m = p === 0 ? markX(x, y, MARK_X, INK[0], 3) : markO(x, y, MARK_O, INK[1], 3);
    if (op) m.setAttribute('opacity', op);
    return m;
  };
  const kids = [];
  if (g.last != null) {
    const [x, y] = center(g.last);
    kids.push(s('rect', { x: x - U / 2 + 2, y: y - U / 2 + 2, width: U - 4, height: U - 4, fill: '#fff09a', opacity: .9, rx: 3 }));
  }
  if (ui.sel != null) {
    const [x, y] = center(ui.sel);
    kids.push(s('rect', { x: x - U / 2 + 1, y: y - U / 2 + 1, width: U - 2, height: U - 2, fill: INK[me], 'fill-opacity': .12, stroke: INK[me], 'stroke-width': 2.5, 'stroke-dasharray': '4 3', class: 'five-sel' }));
  }
  g.cells.forEach((p, i) => { if (p >= 0) kids.push(mark(i, p)); });
  if (ui.sel != null) kids.push(mark(ui.sel, me, .55));
  if (g.line) {
    const [x1, y1] = center(g.line[0]), [x2, y2] = center(g.line[1]);
    const dx = Math.sign(x2 - x1) * U * .45, dy = Math.sign(y2 - y1) * U * .45;
    kids.push(roughLine(x1 - dx, y1 - dy, x2 + dx, y2 + dy, { stroke: '#3b3a36', 'stroke-width': 4, opacity: .8 }, 1.5));
  }
  d.svg.replaceChildren(...kids);

  d.names.replaceChildren(h('b', { class: 'ink0' }, '✕ ' + ctx.names[0]), '  ', h('b', { class: 'ink1' }, '◯ ' + ctx.names[1]));
  // the row always keeps its place, so nothing on the page moves when the turn changes
  d.confirmRow.style.display = g.over ? 'none' : '';
  d.confirm.disabled = !myTurn || ui.sel == null;
  d.confirm.textContent = !myTurn ? T(`מחכים ל${ctx.names[ctx.other]}…`, `Waiting for ${ctx.names[ctx.other]}…`) : ui.sel == null ? T('לוחצים על משבצת', 'Tap a square') : T('לסמן כאן ✓ (או לחיצה נוספת)', 'Mark here ✓ (or tap again)');

  // first paint: open the sheet on the action; later: slide to a new mark that is out of sight
  const first = ui.seenLast === undefined;
  const newMove = g.last != null && g.last !== ui.seenLast;
  ui.seenLast = g.last;
  if (first || newMove) {
    const focus = g.last != null ? g.last : Math.floor(N * N / 2);
    requestAnimationFrame(() => {
      const w = d.wrap;
      const x = (focus % N + .5) * cell, y = (Math.floor(focus / N) + .5) * cell;
      if (first) { w.scrollLeft = x - w.clientWidth / 2; w.scrollTop = y - w.clientHeight / 2; return; }
      const seen = x > w.scrollLeft + cell / 2 && x < w.scrollLeft + w.clientWidth - cell / 2
        && y > w.scrollTop + cell / 2 && y < w.scrollTop + w.clientHeight - cell / 2;
      if (!seen) {
        try { w.scrollTo({ left: x - w.clientWidth / 2, top: y - w.clientHeight / 2, behavior: 'smooth' }); }
        catch { w.scrollLeft = x - w.clientWidth / 2; w.scrollTop = y - w.clientHeight / 2; }
      }
    });
  }
}

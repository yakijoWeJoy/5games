import { h, s, markX, markO, INK } from '../ui.js';

const N = 21;      // a big sheet of squared paper
const U = 30;      // drawing units per square
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

let ui = { id: null };
function sync(g) {
  if (ui.id !== g.id) ui = { id: g.id, sel: null, cell: ui.cell || 30, scroll: null };
}

export default {
  id: 'five',
  title: '5 בשורה',
  sub: 'דף משבצות ענק · הראשון שמשלים 5 ברצף',

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
      ? { mine: true, text: `תורך לסמן ${sym}` }
      : { mine: false, text: `התור של ${names[other]}…` };
  },

  overDetail(g, { me }) {
    return g.over.winner == null ? 'הדף התמלא!' : g.over.winner === me ? 'חמש בשורה! ✋' : 'חמש בשורה… בפעם הבאה 💪';
  },

  render(root, g, ctx) {
    sync(g);
    const { me, send } = ctx;
    const myTurn = g.turn === me && !g.over;
    const rerender = () => { root.replaceChildren(); this.render(root, g, ctx); };
    if (ui.sel != null && g.cells[ui.sel] !== -1) ui.sel = null;

    const cell = ui.cell;
    const wrap = h('div', { class: 'five-wrap' });
    const boardPx = N * cell;
    const boardEl = h('div', {
      class: 'five-board',
      style: {
        width: boardPx + 'px', height: boardPx + 'px',
        backgroundImage: 'linear-gradient(rgba(70,120,190,.38) 1px, transparent 1px), linear-gradient(90deg, rgba(70,120,190,.38) 1px, transparent 1px)',
        backgroundSize: `${cell}px ${cell}px`,
        backgroundColor: 'rgba(255,255,255,.4)',
      },
    });
    const svg = s('svg', { viewBox: `0 0 ${N * U} ${N * U}` });
    const center = i => [(i % N) * U + U / 2, Math.floor(i / N) * U + U / 2];
    const mark = (i, p, op = 1) => {
      const [x, y] = center(i);
      const m = p === 0 ? markX(x, y, U * .3, INK[0], 3.2) : markO(x, y, U * .33, INK[1], 3.2);
      if (op < 1) m.setAttribute('opacity', op);
      return m;
    };
    if (g.last != null) {
      const [x, y] = center(g.last);
      svg.append(s('rect', { x: x - U / 2 + 2, y: y - U / 2 + 2, width: U - 4, height: U - 4, fill: '#fff09a', opacity: .9, rx: 3 }));
    }
    g.cells.forEach((p, i) => { if (p >= 0) svg.append(mark(i, p)); });
    if (ui.sel != null && myTurn) {
      const [x, y] = center(ui.sel);
      svg.append(s('rect', { x: x - U / 2 + 1, y: y - U / 2 + 1, width: U - 2, height: U - 2, fill: 'none', stroke: INK[me], 'stroke-width': 2, 'stroke-dasharray': '4 3' }));
      svg.append(mark(ui.sel, me, .4));
    }
    if (g.line) {
      const [x1, y1] = center(g.line[0]), [x2, y2] = center(g.line[1]);
      const dx = Math.sign(x2 - x1) * U * .45, dy = Math.sign(y2 - y1) * U * .45;
      svg.append(s('path', { d: `M${x1 - dx} ${y1 - dy} L${x2 + dx} ${y2 + dy}`, stroke: '#3b3a36', 'stroke-width': 4, 'stroke-linecap': 'round', filter: 'url(#rough)', opacity: .8 }));
    }
    boardEl.append(svg);
    boardEl.addEventListener('click', e => {
      if (!myTurn) return;
      const rect = boardEl.getBoundingClientRect();
      const c = Math.floor((e.clientX - rect.left) / cell), r = Math.floor((e.clientY - rect.top) / cell);
      if (r < 0 || r >= N || c < 0 || c >= N) return;
      const i = r * N + c;
      if (g.cells[i] !== -1) return;
      if (ui.sel === i) { ui.sel = null; send({ k: 'put', i }); return; }
      ui.sel = i; rerender();
    });
    wrap.append(boardEl);
    wrap.addEventListener('scroll', () => { ui.scroll = [wrap.scrollLeft, wrap.scrollTop]; }, { passive: true });

    root.append(
      h('div', { class: 'row', style: { justifyContent: 'space-between' } },
        h('span', {}, h('b', { class: 'ink0' }, '✕ ' + ctx.names[0]), '  ', h('b', { class: 'ink1' }, '◯ ' + ctx.names[1])),
        h('div', { class: 'zoom' },
          h('button', { class: 'btn small', onclick: () => { ui.cell = Math.max(20, ui.cell - 4); ui.scroll = null; rerender(); } }, '−'),
          h('button', { class: 'btn small', onclick: () => { ui.cell = Math.min(46, ui.cell + 4); ui.scroll = null; rerender(); } }, '+'))),
      wrap);
    if (myTurn) {
      root.append(h('div', { class: 'center' }, h('button', {
        class: 'btn marker', disabled: ui.sel == null,
        onclick: () => { const i = ui.sel; ui.sel = null; send({ k: 'put', i }); },
      }, ui.sel == null ? 'לוחצים על משבצת' : 'לסמן כאן ✓ (או לחיצה נוספת)')));
    }

    // keep the scroll position between updates; start in the middle of the sheet
    const focus = ui.scroll ? null : (g.last != null ? g.last : Math.floor(N * N / 2));
    requestAnimationFrame(() => {
      if (ui.scroll) { wrap.scrollLeft = ui.scroll[0]; wrap.scrollTop = ui.scroll[1]; return; }
      const [x, y] = [(focus % N + .5) * cell, (Math.floor(focus / N) + .5) * cell];
      wrap.scrollLeft = x - wrap.clientWidth / 2;
      wrap.scrollTop = y - wrap.clientHeight / 2;
    });
  },
};

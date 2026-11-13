import { h, s, INK } from '../ui.js';

const D = 6;            // dots per side
const B = D - 1;        // boxes per side
const GAP = 50, M = 25; // drawing units
const px = i => M + i * GAP;

const boxDone = (g, r, c) => g.h[r][c] >= 0 && g.h[r + 1][c] >= 0 && g.v[r][c] >= 0 && g.v[r][c + 1] >= 0;

export default {
  id: 'dots',
  title: 'נקודות',
  sub: '6×6 נקודות · מי שסוגר ריבוע מקבל אותו ועוד תור',

  init(starter) {
    return {
      starter, turn: starter,
      h: Array.from({ length: D }, () => Array(B).fill(-1)),
      v: Array.from({ length: B }, () => Array(D).fill(-1)),
      box: Array.from({ length: B }, () => Array(B).fill(-1)),
      last: null, lastGot: 0, over: null,
    };
  },

  apply(g, a, p) {
    if (a.k !== 'line' || g.turn !== p) return false;
    const { o, r, c } = a;
    const arr = o === 'h' ? g.h : o === 'v' ? g.v : null;
    if (!arr || !Number.isInteger(r) || !Number.isInteger(c) || !arr[r] || arr[r][c] !== -1) return false;
    arr[r][c] = p;
    const cand = o === 'h' ? [[r - 1, c], [r, c]] : [[r, c - 1], [r, c]];
    let got = 0;
    for (const [br, bc] of cand) {
      if (br < 0 || bc < 0 || br >= B || bc >= B || g.box[br][bc] !== -1) continue;
      if (boxDone(g, br, bc)) { g.box[br][bc] = p; got++; }
    }
    g.last = { o, r, c, p };
    g.lastGot = got;
    if (!got) g.turn = 1 - p;
    const flat = g.box.flat();
    if (flat.every(x => x >= 0)) {
      const n0 = flat.filter(x => x === 0).length, n1 = flat.length - n0;
      g.over = { winner: n0 === n1 ? null : n0 > n1 ? 0 : 1 };
    }
    return true;
  },

  status(g, { me, other, names }) {
    if (g.turn === me) {
      const extra = g.last && g.last.p === me && g.lastGot ? 'סגרת ריבוע! עוד תור ✨' : 'תורך – מותחים קו';
      return { mine: true, text: extra };
    }
    return { mine: false, text: g.last && g.last.p === other && g.lastGot ? `${names[other]} סגר/ה ריבוע וממשיך/ה…` : `התור של ${names[other]}…` };
  },

  overDetail(g, { names }) {
    const flat = g.box.flat();
    const n0 = flat.filter(x => x === 0).length;
    return `${names[0]}: ${n0} ריבועים · ${names[1]}: ${flat.length - n0} ריבועים`;
  },

  render(root, g, ctx) {
    const { me, names, send } = ctx;
    const myTurn = g.turn === me && !g.over;
    const flat = g.box.flat();
    const cnt = p => flat.filter(x => x === p).length;
    root.append(h('div', { class: 'dots-score' },
      h('span', { class: 'ink0' }, `${names[0]}: ${cnt(0)}`),
      h('span', { class: 'ink1' }, `${names[1]}: ${cnt(1)}`)));

    const size = M * 2 + GAP * B;
    const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: 'dots-svg', style: 'direction:ltr' });

    // owned boxes: the player's initial, like writing it inside the square
    for (let r = 0; r < B; r++) for (let c = 0; c < B; c++) {
      const o = g.box[r][c];
      if (o < 0) continue;
      svg.append(s('rect', { x: px(c) + 4, y: px(r) + 4, width: GAP - 8, height: GAP - 8, fill: INK[o], opacity: .07 }));
      svg.append(s('text', {
        x: px(c) + GAP / 2, y: px(r) + GAP / 2 + 13, 'text-anchor': 'middle', 'font-size': 40, 'font-weight': 700, 'font-family': 'Amatic SC, sans-serif',
        fill: INK[o], filter: 'url(#rough)', transform: `rotate(${((r * 7 + c * 13) % 9) - 4} ${px(c) + GAP / 2} ${px(r) + GAP / 2})`,
      }, (names[o] || '?').trim()[0]));
    }

    const line = (o, r, c) => o === 'h' ? [px(c), px(r), px(c + 1), px(r)] : [px(c), px(r), px(c), px(r + 1)];
    const last = g.last;
    if (last) {
      const [x1, y1, x2, y2] = line(last.o, last.r, last.c);
      svg.append(s('path', { d: `M${x1} ${y1} L${x2} ${y2}`, stroke: '#ffe45c', 'stroke-width': 12, 'stroke-linecap': 'round', opacity: .8 }));
    }
    const drawn = s('g', { 'stroke-width': 4, 'stroke-linecap': 'round', filter: 'url(#rough)' });
    const hits = s('g', {});
    const addEdge = (o, r, c, who) => {
      const [x1, y1, x2, y2] = line(o, r, c);
      if (who >= 0) { drawn.append(s('path', { d: `M${x1} ${y1} L${x2} ${y2}`, stroke: INK[who] })); return; }
      if (!myTurn) return;
      // the whole diamond around a missing line is tappable
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, half = GAP / 2;
      const pts = o === 'h'
        ? `${x1},${y1} ${mx},${my - half} ${x2},${y2} ${mx},${my + half}`
        : `${x1},${y1} ${mx - half},${my} ${x2},${y2} ${mx + half},${my}`;
      const poly = s('polygon', { points: pts, fill: 'transparent', style: 'cursor:pointer' });
      const ghost = s('path', { d: `M${x1} ${y1} L${x2} ${y2}`, stroke: INK[me], 'stroke-width': 3, 'stroke-dasharray': '3 6', opacity: 0, 'pointer-events': 'none' });
      poly.addEventListener('pointerenter', () => ghost.setAttribute('opacity', .5));
      poly.addEventListener('pointerleave', () => ghost.setAttribute('opacity', 0));
      poly.addEventListener('click', () => send({ k: 'line', o, r, c }));
      hits.append(ghost, poly);
    };
    for (let r = 0; r < D; r++) for (let c = 0; c < B; c++) addEdge('h', r, c, g.h[r][c]);
    for (let r = 0; r < B; r++) for (let c = 0; c < D; c++) addEdge('v', r, c, g.v[r][c]);
    svg.append(drawn);
    for (let r = 0; r < D; r++) for (let c = 0; c < D; c++) svg.append(s('circle', { cx: px(c), cy: px(r), r: 4, fill: '#3b3a36' }));
    svg.append(hits);
    root.append(svg);
    if (myTurn) root.append(h('p', { class: 'center soft', style: { fontSize: '14px' } }, 'לוחצים בין שתי נקודות כדי למתוח קו'));
  },
};

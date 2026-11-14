export const SVGNS = 'http://www.w3.org/2000/svg';
export const INK = ['#2350b8', '#c5332b'];
export const PENCIL = '#3b3a36';

function setProps(el, props, isSvg) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') isSvg ? el.setAttribute('class', v) : (el.className = v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value' && !isSvg) el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
}
function addKids(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  setProps(el, props, false);
  addKids(el, kids);
  return el;
}
export function s(tag, props, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  setProps(el, props, true);
  addKids(el, kids);
  return el;
}

export function toast(text, title, ms = 2800) {
  const el = h('div', { class: 'toast' }, title ? h('b', {}, title) : null, text);
  document.body.append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, ms);
}

export function confirmBox(text, yes = 'כן', no = 'ביטול') {
  return new Promise(res => {
    const bg = h('div', { class: 'modal-bg' });
    const done = v => { bg.remove(); res(v); };
    bg.append(h('div', { class: 'modal card' },
      h('p', {}, text),
      h('div', { class: 'row center' },
        h('button', { class: 'btn marker', onclick: () => done(true) }, yes),
        h('button', { class: 'btn ghost', onclick: () => done(false) }, no))));
    document.body.append(bg);
  });
}

export function buzz(pattern = 40) {
  try {
    // browsers refuse to vibrate before the first tap on the page
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate && navigator.vibrate(pattern);
  } catch { /* ignore */ }
}

/* ---------- hand-drawn strokes, as plain geometry (no SVG filters: some phone browsers do not paint them) ---------- */

const jit = seed => { const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) - 0.5; };
const f1 = n => n.toFixed(1);

/** path data of a slightly wobbly line, like one drawn by hand. Deterministic for the same input. */
export function roughD(x1, y1, x2, y2, amp) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const a = amp == null ? Math.min(2.4, 0.5 + len * 0.02) : amp;
  const seed = x1 * 3.1 + y1 * 7.3 + x2 * 1.7 + y2 * 5.9;
  const nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
  const pt = (t, o) => `${f1(x1 + (x2 - x1) * t + nx * o)} ${f1(y1 + (y2 - y1) * t + ny * o)}`;
  const o1 = jit(seed + 2) * 2 * a, o2 = jit(seed + 3) * 2 * a;
  return `M${pt(jit(seed + 4) * 0.02, jit(seed + 5) * a * .6)} C${pt(0.3 + jit(seed) * 0.1, o1)} ${pt(0.7 + jit(seed + 1) * 0.1, o2)} ${pt(1 + jit(seed + 6) * 0.02, jit(seed + 7) * a * .6)}`;
}
export function roughLine(x1, y1, x2, y2, attrs, amp) {
  return s('path', { d: roughD(x1, y1, x2, y2, amp), fill: 'none', 'stroke-linecap': 'round', ...attrs });
}
/** a circle drawn in one go: slightly squashed and not perfectly closed */
export function roughCircle(cx, cy, r, attrs) {
  const seed = cx * 1.3 + cy * 2.9 + r;
  const a0 = -1.9 + jit(seed) * .8, a1 = a0 + Math.PI * 2.07;
  const rx = r * (1 + jit(seed + 1) * .08), ry = r * (0.95 + jit(seed + 2) * .08);
  const p = (a, k) => `${f1(cx + Math.cos(a) * rx * k)} ${f1(cy + Math.sin(a) * ry * k)}`;
  return s('path', { d: `M${p(a0, 1)} A${f1(rx)} ${f1(ry)} 0 1 1 ${p(a1, 1.05)}`, fill: 'none', 'stroke-linecap': 'round', ...attrs });
}

/** Tally marks in groups of five, like on the scoring page. */
export function tally(n, p) {
  const groups = Math.max(1, Math.ceil(n / 5));
  const w = groups * 30 + 4;
  const svg = s('svg', { viewBox: `0 0 ${w} 22`, width: w, height: 22, class: 'tally' });
  if (n === 0) {
    svg.append(s('path', { d: 'M6 12 L16 12', stroke: INK[p], 'stroke-width': 2, opacity: .35, 'stroke-linecap': 'round' }));
    return svg;
  }
  const st = { stroke: INK[p], 'stroke-width': 2.2 };
  for (let i = 0; i < n; i++) {
    const grp = Math.floor(i / 5), k = i % 5, x0 = grp * 30 + 5;
    if (k < 4) { const x = x0 + k * 5.5; svg.append(roughLine(x, 3, x + .7, 19, st, .5)); }
    else svg.append(roughLine(x0 - 3, 16, x0 + 20, 6, st, .6));
  }
  return svg;
}

/** Hand-drawn X and O marks (centered at cx,cy, size r). */
export function markX(cx, cy, r, color, width = 3) {
  const st = { stroke: color, 'stroke-width': width };
  return s('g', {},
    roughLine(cx - r, cy - r, cx + r, cy + r, st, r * .09),
    roughLine(cx + r, cy - r, cx - r * .95, cy + r * 1.05, st, r * .09));
}
export function markO(cx, cy, r, color, width = 3) {
  return roughCircle(cx, cy, r, { stroke: color, 'stroke-width': width });
}
export function markDot(cx, cy, r, color) {
  return s('circle', { cx, cy, r, fill: color });
}

export const rid = (n = 8) => Math.random().toString(36).slice(2, 2 + n);

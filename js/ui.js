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

/** Tally marks in groups of five, like on the scoring page. */
export function tally(n, p) {
  const groups = Math.max(1, Math.ceil(n / 5));
  const w = groups * 30 + 4;
  const svg = s('svg', { viewBox: `0 0 ${w} 22`, width: w, height: 22, class: 'tally' });
  if (n === 0) {
    svg.append(s('path', { d: 'M6 12 L16 12', stroke: INK[p], 'stroke-width': 2, opacity: .35, 'stroke-linecap': 'round' }));
    return svg;
  }
  const g = s('g', { stroke: INK[p], 'stroke-width': 2.2, 'stroke-linecap': 'round', fill: 'none', filter: 'url(#rough)' });
  for (let i = 0; i < n; i++) {
    const grp = Math.floor(i / 5), k = i % 5, x0 = grp * 30 + 5;
    if (k < 4) { const x = x0 + k * 5.5; g.append(s('path', { d: `M${x} 3 L${x + .7} 19` })); }
    else g.append(s('path', { d: `M${x0 - 3} 16 L${x0 + 20} 6` }));
  }
  svg.append(g);
  return svg;
}

/** Hand-drawn X and O marks (centered at cx,cy, size r). */
export function markX(cx, cy, r, color, width = 3) {
  return s('g', { stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', filter: 'url(#rough)' },
    s('path', { d: `M${cx - r} ${cy - r} L${cx + r} ${cy + r}` }),
    s('path', { d: `M${cx + r} ${cy - r} L${cx - r * .95} ${cy + r * 1.05}` }));
}
export function markO(cx, cy, r, color, width = 3) {
  // slightly open circle, like drawn in one stroke
  const a0 = -1.9, a1 = a0 + Math.PI * 2.08;
  const p = (a, rr) => `${(cx + Math.cos(a) * rr).toFixed(1)} ${(cy + Math.sin(a) * rr).toFixed(1)}`;
  return s('path', {
    d: `M${p(a0, r)} A${r} ${r * .95} 0 1 1 ${p(a1, r * 1.04)}`,
    stroke: color, 'stroke-width': width, fill: 'none', 'stroke-linecap': 'round', filter: 'url(#rough)',
  });
}
export function markDot(cx, cy, r, color) {
  return s('circle', { cx, cy, r, fill: color });
}

export const rid = (n = 8) => Math.random().toString(36).slice(2, 2 + n);

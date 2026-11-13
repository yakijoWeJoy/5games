import { h, s } from '../ui.js';

const MAX = 10;
const HE = 'אבגדהוזחטיכלמנסעפצקרשת'.split('');
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const HE_ENTRY = [...HE, ...Object.keys(FINALS)];
const EN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const norm = ch => FINALS[ch] || ch.toUpperCase();
const lettersOf = lang => (lang === 'en' ? EN : HE);
const entryLetters = lang => (lang === 'en' ? EN : HE_ENTRY);

function validWord(w) {
  if (!w || (w.lang !== 'he' && w.lang !== 'en') || typeof w.text !== 'string') return false;
  const t = w.text.trim();
  if (t.length < 2 || t.length > 24) return false;
  const allowed = new Set(entryLetters(w.lang));
  let letters = 0;
  for (const ch of t) {
    if (ch === ' ') continue;
    if (!allowed.has(w.lang === 'en' ? ch.toUpperCase() : ch)) return false;
    letters++;
  }
  return letters >= 2;
}
const needed = text => new Set([...text].filter(c => c !== ' ').map(norm));
const isSolved = (text, guessed) => [...needed(text)].every(l => guessed.includes(l));

let ui = { id: null, lang: 'he', entry: '', hint: '', solve: false, solveEntry: '' };
function sync(g) {
  if (ui.id !== g.id) ui = { id: g.id, lang: ui.lang || 'he', entry: '', hint: '', solve: false, solveEntry: '' };
}

/** The gallows, drawn stroke by stroke. */
export function gallows(n, color, size = 150) {
  const parts = [
    'M10 122 L112 122', 'M32 122 L32 10', 'M32 10 L86 10', 'M86 10 L86 26', null,
    'M86 50 L86 84', 'M86 58 L70 74', 'M86 58 L102 74', 'M86 84 L73 106', 'M86 84 L99 106',
  ];
  const g = s('g', { stroke: color, 'stroke-width': 3, 'stroke-linecap': 'round', fill: 'none', filter: 'url(#rough)' });
  for (let i = 0; i < Math.min(n, MAX); i++) {
    if (i === 4) g.append(s('circle', { cx: 86, cy: 38, r: 12 }));
    else g.append(s('path', { d: parts[i] }));
  }
  if (n >= 3) g.append(s('path', { d: 'M32 30 L50 10', 'stroke-width': 2 }));
  if (n >= MAX) {
    g.append(s('path', { d: 'M80 34 L84 38 M84 34 L80 38 M88 34 L92 38 M92 34 L88 38', 'stroke-width': 1.6 }));
  }
  const svg = s('svg', { viewBox: '0 0 120 130', width: size, height: size * 130 / 120, class: 'gallows' });
  svg.append(s('path', { d: 'M10 122 L112 122', stroke: '#000', 'stroke-opacity': .07, 'stroke-width': 3 }), g);
  return svg;
}

function wordView(text, lang, guessed, { ghost = false, small = false, color } = {}) {
  const box = h('div', { class: 'word' + (small ? ' small' : ''), style: { direction: lang === 'en' ? 'ltr' : 'rtl' } });
  for (const ch of text) {
    if (ch === ' ') { box.append(h('div', { class: 'ch sp' })); continue; }
    const shown = guessed.includes(norm(ch));
    box.append(h('div', {
      class: 'ch' + (!shown && ghost ? ' ghost' : ''),
      style: shown && color ? { color } : {},
    }, shown || ghost ? (lang === 'en' ? ch.toUpperCase() : ch) : ''));
  }
  return box;
}

function keyboard(letters, onKey, { cols = 7, disabled = false, state = () => '' } = {}) {
  const keys = h('div', { class: 'keys', style: { gridTemplateColumns: `repeat(${cols}, 1fr)`, direction: letters === EN ? 'ltr' : 'rtl' } });
  for (const l of letters) {
    const st = state(l);
    keys.append(h('button', { class: 'key ' + st, disabled: disabled || !!st, onclick: () => onKey(l) }, l));
  }
  return keys;
}

export default {
  id: 'hangman',
  title: 'איש תלוי',
  sub: 'כל אחד בוחר מילה, ושואלים אות אחרי אות',

  init(starter) {
    return { starter, turn: starter, phase: 'word', words: [null, null], guessed: [[], []], wrong: [0, 0], over: null };
  },

  apply(g, a, p) {
    if (a.k === 'word') {
      const w = { text: String(a.text || '').trim().replace(/\s+/g, ' '), lang: a.lang, hint: String(a.hint || '').trim().slice(0, 40) };
      if (g.phase !== 'word' || g.words[p] || !validWord(w)) return false;
      if (w.lang === 'en') w.text = w.text.toUpperCase();
      g.words[p] = w;
      if (g.words[0] && g.words[1]) g.phase = 'play';
      return true;
    }
    if (g.phase !== 'play' || g.turn !== p) return false;
    const target = g.words[1 - p];
    if (a.k === 'letter') {
      const l = norm(String(a.l || ''));
      if (!lettersOf(target.lang).includes(l) || g.guessed[p].includes(l)) return false;
      g.guessed[p].push(l);
      g.last = { p, l, hit: needed(target.text).has(l) };
      if (g.last.hit) {
        if (isSolved(target.text, g.guessed[p])) { g.over = { winner: p }; return true; }
      } else if (++g.wrong[p] >= MAX) { g.over = { winner: 1 - p, hanged: p }; return true; }
      g.turn = 1 - p;
      return true;
    }
    if (a.k === 'solve') {
      const clean = t => [...String(t || '')].filter(c => c !== ' ').map(norm).join('');
      if (clean(a.text) && clean(a.text) === clean(target.text)) {
        for (const l of needed(target.text)) if (!g.guessed[p].includes(l)) g.guessed[p].push(l);
        g.over = { winner: p };
        return true;
      }
      g.last = { p, word: String(a.text).slice(0, 24), hit: false };
      if (++g.wrong[p] >= MAX) { g.over = { winner: 1 - p, hanged: p }; return true; }
      g.turn = 1 - p;
      return true;
    }
    return false;
  },

  status(g, { me, other, names }) {
    if (g.phase === 'word') {
      return g.words[me]
        ? { mine: false, text: `מחכים ש${names[other]} יבחר/תבחר מילה…` }
        : { mine: true, text: 'בחרו מילה סודית ✏️' };
    }
    let t = '';
    if (g.last && g.last.p === other) {
      t = g.last.word ? `${names[other]} ניסה/תה "${g.last.word}" – לא! · ` :
        `${names[other]} שאל/ה "${g.last.l}" – ${g.last.hit ? 'יש!' : 'אין'} · `;
    }
    return g.turn === me ? { mine: true, text: t + 'תורך לבחור אות' } : { mine: false, text: `התור של ${names[other]}…` };
  },

  overDetail(g, { me, other, names }) {
    const hang = g.over.hanged != null ? (g.over.hanged === me ? 'נתלית… 😵 ' : `${names[other]} נתלה/תה! `) : '';
    return `${hang}המילה של ${names[other]}: "${g.words[other].text}" · המילה שלי: "${g.words[me].text}"`;
  },

  render(root, g, ctx) {
    sync(g);
    const { me, other, names, send } = ctx;
    const myInk = `var(--ink${me})`, theirInk = `var(--ink${other})`;
    const rerender = () => { root.replaceChildren(); this.render(root, g, ctx); };

    if (g.phase === 'word') {
      if (g.words[me]) {
        root.append(h('div', { class: 'card center' },
          h('div', {}, 'המילה שלי'),
          wordView(g.words[me].text, g.words[me].lang, [], { ghost: true }),
          g.words[me].hint ? h('div', { class: 'hint' }, 'רמז: ', g.words[me].hint) : null,
          h('p', { class: 'soft' }, 'ששש… 🤐')));
        return;
      }
      const lang = ui.lang;
      const hintIn = h('input', { class: 'paper', placeholder: 'רמז (לא חובה) – למשל: חיה, עיר, שיר…', maxlength: 40, value: ui.hint });
      hintIn.addEventListener('input', () => { ui.hint = hintIn.value; });
      const display = ui.entry
        ? h('div', { class: 'word', style: { direction: lang === 'en' ? 'ltr' : 'rtl', color: myInk } },
          [...ui.entry].map(ch => h('div', { class: 'ch' + (ch === ' ' ? ' sp' : '') }, ch === ' ' ? '' : ch)))
        : h('p', { class: 'center soft' }, 'הקלידו את המילה במקלדת למטה');
      const kb = keyboard(entryLetters(lang), l => { if (ui.entry.length < 24) { ui.entry += l; rerender(); } }, { cols: lang === 'en' ? 7 : 7 });
      kb.append(
        h('button', { class: 'key wide', onclick: () => { if (ui.entry && !ui.entry.endsWith(' ')) { ui.entry += ' '; rerender(); } } }, 'רווח'),
        h('button', { class: 'key wide', disabled: !ui.entry, onclick: () => { ui.entry = ui.entry.slice(0, -1); rerender(); } }, '⌫'));
      root.append(
        h('div', { class: 'row center' },
          h('button', { class: 'btn small' + (lang === 'he' ? ' marker' : ''), onclick: () => { ui.lang = 'he'; ui.entry = ''; rerender(); } }, 'עברית'),
          h('button', { class: 'btn small' + (lang === 'en' ? ' marker' : ''), onclick: () => { ui.lang = 'en'; ui.entry = ''; rerender(); } }, 'English')),
        display, kb, hintIn,
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn big marker',
          disabled: !validWord({ text: ui.entry, lang }),
          onclick: () => send({ k: 'word', text: ui.entry, lang, hint: ui.hint }),
        }, 'זאת המילה! 🔒'));
      return;
    }

    // ----- play -----
    const target = g.words[other];
    const mine = g.words[me];
    const myTurn = g.turn === me && !g.over;
    const tNeeded = needed(target.text);

    root.append(h('h3', { class: 'center', style: { color: theirInk } }, `המילה של ${names[other]}`));
    if (target.hint) root.append(h('div', { class: 'hint' }, 'רמז: ', h('b', {}, target.hint)));
    root.append(wordView(target.text, target.lang, g.guessed[me], { color: myInk, ghost: !!g.over }));
    root.append(h('div', { class: 'row center', style: { flexWrap: 'nowrap', alignItems: 'flex-end' } },
      gallows(g.wrong[me], myInk, 130),
      h('div', { class: 'soft' }, `טעויות: ${g.wrong[me]}/${MAX}`)));

    if (!g.over) {
      if (ui.solve) {
        const kb = keyboard(entryLetters(target.lang), l => { if (ui.solveEntry.length < 24) { ui.solveEntry += l; rerender(); } }, { disabled: !myTurn });
        kb.append(
          h('button', { class: 'key wide', onclick: () => { ui.solveEntry += ' '; rerender(); } }, 'רווח'),
          h('button', { class: 'key wide', onclick: () => { ui.solveEntry = ui.solveEntry.slice(0, -1); rerender(); } }, '⌫'));
        root.append(
          h('div', { class: 'card' },
            h('div', { class: 'center' }, 'כל המילה (ניחוש שגוי = טעות אחת):'),
            h('div', { class: 'word', style: { color: myInk, direction: target.lang === 'en' ? 'ltr' : 'rtl' } },
              ui.solveEntry ? [...ui.solveEntry].map(ch => h('div', { class: 'ch' + (ch === ' ' ? ' sp' : '') }, ch === ' ' ? '' : ch)) : h('div', { class: 'soft' }, '…')),
            kb,
            h('div', { class: 'row center' },
              h('button', { class: 'btn marker', disabled: !myTurn || !ui.solveEntry.trim(), onclick: () => { send({ k: 'solve', text: ui.solveEntry }); ui.solve = false; ui.solveEntry = ''; } }, 'זאת המילה!'),
              h('button', { class: 'btn ghost', onclick: () => { ui.solve = false; ui.solveEntry = ''; rerender(); } }, 'חזרה לאותיות'))));
      } else {
        root.append(keyboard(lettersOf(target.lang), l => send({ k: 'letter', l }), {
          disabled: !myTurn,
          state: l => (g.guessed[me].includes(l) ? (tNeeded.has(l) ? 'used-good' : 'used-bad') : ''),
        }));
        root.append(h('div', { class: 'center' },
          h('button', { class: 'link-btn', disabled: !myTurn, onclick: () => { ui.solve = true; rerender(); } }, 'יודע/ת את כל המילה? 💡')));
      }
    }

    root.append(h('hr', { class: 'pencil-line' }));
    root.append(h('div', { class: 'center' },
      h('b', { style: { color: myInk } }, 'המילה שלי'), h('span', { class: 'soft' }, ` – ${names[other]} מנחש/ת`)));
    root.append(h('div', { class: 'row center', style: { flexWrap: 'nowrap', alignItems: 'flex-end' } },
      h('div', {}, wordView(mine.text, mine.lang, g.guessed[other], { ghost: true, small: true, color: theirInk }),
        h('div', { class: 'soft center', style: { fontSize: '14px' } },
          'אותיות ששאל/ה: ', g.guessed[other].join(' ') || '—')),
      gallows(g.wrong[other], theirInk, 80)));
  },
};

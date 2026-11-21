import { h, s, roughLine, roughCircle } from '../ui.js';
import { T, LANG } from '../i18n.js';

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

let ui = { id: null, lang: LANG, entry: '', hint: '', solve: false, solveEntry: '' };
function sync(g) {
  if (ui.id !== g.id) ui = { id: g.id, lang: ui.lang || LANG, entry: '', hint: '', solve: false, solveEntry: '' };
}

/** The gallows, drawn stroke by stroke. */
export function gallows(n, color, size = 150) {
  const st = { stroke: color, 'stroke-width': 3 };
  const parts = [
    () => roughLine(10, 122, 112, 122, st), () => roughLine(32, 122, 32, 10, st), () => roughLine(32, 10, 86, 10, st),
    () => roughLine(86, 10, 86, 26, st, .4), () => roughCircle(86, 38, 12, st),
    () => roughLine(86, 50, 86, 84, st, .6), () => roughLine(86, 58, 70, 74, st, .5), () => roughLine(86, 58, 102, 74, st, .5),
    () => roughLine(86, 84, 73, 106, st, .5), () => roughLine(86, 84, 99, 106, st, .5),
  ];
  const svg = s('svg', { viewBox: '0 0 120 130', width: size, height: size * 130 / 120, class: 'gallows' });
  svg.append(s('path', { d: 'M10 122 L112 122', stroke: '#000', 'stroke-opacity': .07, 'stroke-width': 3 }));
  for (let i = 0; i < Math.min(n, MAX); i++) svg.append(parts[i]());
  if (n >= 3) svg.append(roughLine(32, 30, 50, 10, { stroke: color, 'stroke-width': 2 }, .4));
  if (n >= MAX) svg.append(s('path', { d: 'M80 34 L84 38 M84 34 L80 38 M88 34 L92 38 M92 34 L88 38', stroke: color, 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
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
  title: T('איש תלוי', 'Hangman'),
  sub: T('כל אחד בוחר מילה, ושואלים אות אחרי אות', 'Each picks a word, then you ask letter by letter'),
  help: [
    T('כל אחד בוחר מילה סודית (בעברית או באנגלית), ואפשר להוסיף רמז.', 'Each of you picks a secret word (in English or Hebrew), and can add a hint.'),
    T('מנחשים בתורות אותיות במילה של השני.', 'Take turns guessing letters in the other one\'s word.'),
    T('אות נכונה = <b>עוד תור</b>. אות לא נכונה = עוד קו בציור.', 'Right letter = <b>another turn</b>. Wrong letter = one more line in the drawing.'),
    T('מי שמגלה ראשון את המילה מנצח. 10 טעויות = נתלית 😵', 'First to find the word wins. 10 mistakes = hanged 😵'),
  ],

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
      if (typeof a.l !== 'string') return false;
      const l = norm(a.l);
      if (!lettersOf(target.lang).includes(l) || g.guessed[p].includes(l)) return false;
      g.guessed[p].push(l);
      g.last = { p, l, hit: needed(target.text).has(l) };
      if (g.last.hit) {
        // a letter that is in the word earns another turn
        if (isSolved(target.text, g.guessed[p])) g.over = { winner: p };
        return true;
      }
      if (++g.wrong[p] >= MAX) { g.over = { winner: 1 - p, hanged: p }; return true; }
      g.turn = 1 - p;
      return true;
    }
    if (a.k === 'solve') {
      const clean = t => [...String(t || '')].filter(c => c !== ' ').map(norm).join('');
      if (typeof a.text !== 'string' || !clean(a.text) || a.text.length > 40) return false;
      if (clean(a.text) === clean(target.text)) {
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
        ? { mine: false, text: T(`מחכים ש${names[other]} יבחר/תבחר מילה…`, `Waiting for ${names[other]} to pick a word…`) }
        : { mine: true, text: T('בחרו מילה סודית ✏️', 'Pick a secret word ✏️') };
    }
    const L = g.last;
    if (g.turn === me) {
      if (L && L.p === me && L.hit) return { mine: true, text: T(`יש "${L.l}"! עוד תור ✨`, `"${L.l}" is in! Another turn ✨`) };
      let t = '';
      if (L && L.p === other) t = L.word ? T(`${names[other]} ניסה/תה "${L.word}" – לא! · `, `${names[other]} tried "${L.word}" – no! · `) : T(`${names[other]} שאל/ה "${L.l}" – אין · `, `${names[other]} asked "${L.l}" – not there · `);
      return { mine: true, text: t + T('תורך לבחור אות', 'Your turn to pick a letter') };
    }
    if (L && L.p === other && L.hit) return { mine: false, text: T(`${names[other]} מצא/ה "${L.l}" וממשיך/ה…`, `${names[other]} found "${L.l}" and goes again…`) };
    return { mine: false, text: T(`התור של ${names[other]}…`, `${names[other]}\'s turn…`) };
  },

  overDetail(g, { me, other, names }) {
    const hang = g.over.hanged != null ? (g.over.hanged === me ? T('נתלית… 😵 ', 'You were hanged… 😵 ') : T(`${names[other]} נתלה/תה! `, `${names[other]} was hanged! `)) : '';
    return T(`${hang}המילה של ${names[other]}: "${g.words[other].text}" · המילה שלי: "${g.words[me].text}"`, `${hang}${names[other]}\'s word: "${g.words[other].text}" · my word: "${g.words[me].text}"`);
  },

  render(root, g, ctx) {
    root.replaceChildren();
    sync(g);
    const { me, other, names, send } = ctx;
    const myInk = `var(--ink${me})`, theirInk = `var(--ink${other})`;
    const rerender = () => { root.replaceChildren(); this.render(root, g, ctx); };

    if (g.phase === 'word') {
      if (g.words[me]) {
        root.append(h('div', { class: 'card center' },
          h('div', {}, T('המילה שלי', 'My word')),
          wordView(g.words[me].text, g.words[me].lang, [], { ghost: true }),
          g.words[me].hint ? h('div', { class: 'hint' }, T('רמז: ', 'Hint: '), g.words[me].hint) : null,
          h('p', { class: 'soft' }, T('ששש… 🤐', 'Shhh… 🤐'))));
        return;
      }
      const lang = ui.lang;
      const hintIn = h('input', { class: 'paper', placeholder: T('רמז (לא חובה) – למשל: חיה, עיר, שיר…', 'Hint (optional) – e.g. animal, city, song…'), maxlength: 40, value: ui.hint, 'data-fk': 'hint' });
      hintIn.addEventListener('input', () => { ui.hint = hintIn.value; });
      const display = ui.entry
        ? h('div', { class: 'word', style: { direction: lang === 'en' ? 'ltr' : 'rtl', color: myInk } },
          [...ui.entry].map(ch => h('div', { class: 'ch' + (ch === ' ' ? ' sp' : '') }, ch === ' ' ? '' : ch)))
        : h('p', { class: 'center soft', style: { margin: 0 } }, T('הקלידו את המילה במקלדת למטה', 'Type the word on the keyboard below'));
      const displayBox = h('div', { class: 'word-entry' }, display);
      const kb = keyboard(entryLetters(lang), l => { if (ui.entry.length < 24) { ui.entry += l; rerender(); } }, { cols: lang === 'en' ? 7 : 7 });
      kb.append(
        h('button', { class: 'key wide', onclick: () => { if (ui.entry && !ui.entry.endsWith(' ')) { ui.entry += ' '; rerender(); } } }, T('רווח', 'Space')),
        h('button', { class: 'key wide', disabled: !ui.entry, onclick: () => { ui.entry = ui.entry.slice(0, -1); rerender(); } }, '⌫'));
      root.append(
        h('div', { class: 'row center' },
          h('button', { class: 'btn small' + (lang === 'he' ? ' marker' : ''), onclick: () => { ui.lang = 'he'; ui.entry = ''; rerender(); } }, 'עברית'),
          h('button', { class: 'btn small' + (lang === 'en' ? ' marker' : ''), onclick: () => { ui.lang = 'en'; ui.entry = ''; rerender(); } }, 'English')),
        displayBox, kb, hintIn,
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn big marker',
          disabled: !validWord({ text: ui.entry, lang }),
          onclick: () => send({ k: 'word', text: ui.entry, lang, hint: ui.hint }),
        }, T('זאת המילה! 🔒', 'That\'s my word! 🔒')));
      return;
    }

    // ----- play -----
    const target = g.words[other];
    const mine = g.words[me];
    const myTurn = g.turn === me && !g.over;
    const tNeeded = needed(target.text);

    root.append(h('h3', { class: 'center', style: { color: theirInk } }, T(`המילה של ${names[other]}`, `${names[other]}\'s word`)));
    if (target.hint) root.append(h('div', { class: 'hint' }, T('רמז: ', 'Hint: '), h('b', {}, target.hint)));
    root.append(wordView(target.text, target.lang, g.guessed[me], { color: myInk, ghost: !!g.over }));
    root.append(h('div', { class: 'row center', style: { flexWrap: 'nowrap', alignItems: 'flex-end' } },
      gallows(g.wrong[me], myInk, 130),
      h('div', { class: 'soft' }, T(`טעויות: ${g.wrong[me]}/${MAX}`, `Mistakes: ${g.wrong[me]}/${MAX}`))));

    if (!g.over) {
      if (ui.solve) {
        const kb = keyboard(entryLetters(target.lang), l => { if (ui.solveEntry.length < 24) { ui.solveEntry += l; rerender(); } }, { disabled: !myTurn });
        kb.append(
          h('button', { class: 'key wide', onclick: () => { ui.solveEntry += ' '; rerender(); } }, T('רווח', 'Space')),
          h('button', { class: 'key wide', onclick: () => { ui.solveEntry = ui.solveEntry.slice(0, -1); rerender(); } }, '⌫'));
        root.append(
          h('div', { class: 'card' },
            h('div', { class: 'center' }, T('כל המילה (ניחוש שגוי = טעות אחת):', 'The whole word (a wrong guess = one mistake):')),
            h('div', { class: 'word', style: { color: myInk, direction: target.lang === 'en' ? 'ltr' : 'rtl' } },
              ui.solveEntry ? [...ui.solveEntry].map(ch => h('div', { class: 'ch' + (ch === ' ' ? ' sp' : '') }, ch === ' ' ? '' : ch)) : h('div', { class: 'soft' }, '…')),
            kb,
            h('div', { class: 'row center' },
              h('button', { class: 'btn marker', disabled: !myTurn || !ui.solveEntry.trim(), onclick: () => { send({ k: 'solve', text: ui.solveEntry }); ui.solve = false; ui.solveEntry = ''; } }, T('זאת המילה!', 'That\'s the word!')),
              h('button', { class: 'btn ghost', onclick: () => { ui.solve = false; ui.solveEntry = ''; rerender(); } }, T('חזרה לאותיות', 'Back to letters')))));
      } else {
        root.append(keyboard(lettersOf(target.lang), l => send({ k: 'letter', l }), {
          disabled: !myTurn,
          state: l => (g.guessed[me].includes(l) ? (tNeeded.has(l) ? 'used-good' : 'used-bad') : ''),
        }));
        root.append(h('div', { class: 'center' },
          h('button', { class: 'link-btn', disabled: !myTurn, onclick: () => { ui.solve = true; rerender(); } }, T('יודע/ת את כל המילה? 💡', 'Know the whole word? 💡'))));
      }
    }

    root.append(h('hr', { class: 'pencil-line' }));
    root.append(h('div', { class: 'center' },
      h('b', { style: { color: myInk } }, T('המילה שלי', 'My word')), h('span', { class: 'soft' }, T(` – ${names[other]} מנחש/ת`, ` – ${names[other]} is guessing`))));
    root.append(h('div', { class: 'row center', style: { flexWrap: 'nowrap', alignItems: 'flex-end' } },
      h('div', {}, wordView(mine.text, mine.lang, g.guessed[other], { ghost: true, small: true, color: theirInk }),
        h('div', { class: 'soft center', style: { fontSize: '14px' } },
          T('אותיות ששאל/ה: ', 'Letters asked: '), g.guessed[other].join(' ') || '—')),
      gallows(g.wrong[other], theirInk, 80)));
  },
};

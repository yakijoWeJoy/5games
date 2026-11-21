import { h, toast } from '../ui.js';
import { T } from '../i18n.js';

const valid = c => typeof c === 'string' && /^\d{4}$/.test(c) && new Set(c).size === 4;
function judge(secret, guess) {
  let b = 0, p = 0;
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) b++;
    else if (secret.includes(guess[i])) p++;
  }
  return { b, p };
}
const solved = list => list.some(x => x.b === 4);

let ui = { id: null, entry: '', scratch: {} };
function sync(g) {
  if (ui.id !== g.id) {
    let scratch = {};
    try { scratch = JSON.parse(sessionStorage.getItem('bull-scratch-' + g.id) || '{}'); } catch { /* ignore */ }
    ui = { id: g.id, entry: '', scratch };
  }
}
function saveScratch() { try { sessionStorage.setItem('bull-scratch-' + ui.id, JSON.stringify(ui.scratch)); } catch { /* ignore */ } }

function entryBox(rerender, onSubmit, submitLabel, off) {
  const slots = h('div', { class: 'slots' },
    [0, 1, 2, 3].map(i => h('div', { class: 'slot ink-me' }, ui.entry[i] || '')));
  const keys = h('div', { class: 'keys', style: { gridTemplateColumns: 'repeat(5, 1fr)', direction: 'ltr' } });
  for (const d of '1234567890') {
    keys.append(h('button', {
      class: 'key', disabled: off || ui.entry.includes(d) || ui.entry.length >= 4,
      onclick: () => { ui.entry += d; rerender(); },
    }, d));
  }
  keys.append(
    h('button', { class: 'key wide', disabled: off || !ui.entry, onclick: () => { ui.entry = ui.entry.slice(0, -1); rerender(); } }, T('⌫ מחק', '⌫ Delete')),
    h('button', { class: 'key wide action', disabled: off || ui.entry.length !== 4, onclick: onSubmit, style: { gridColumn: 'span 3' } }, submitLabel));
  return [slots, keys];
}

function guessTable(list, title, ink, mineWinner) {
  return h('div', {},
    h('h3', { style: { color: ink } }, title),
    list.length ? h('table', { class: 'paper' },
      h('tr', {}, h('th', {}, '#'), h('th', {}, T('ניחוש', 'Guess')), h('th', {}, T('בול', 'Bulls')), h('th', {}, T('פגיעה', 'Cows'))),
      list.map((x, i) => h('tr', { class: x.b === 4 ? 'win' : '' },
        h('td', { class: 'soft' }, i + 1),
        h('td', { class: 'code', style: { color: ink } }, x.code),
        h('td', {}, x.b || '–'),
        h('td', {}, x.p || '–'))))
      : h('p', { class: 'soft' }, mineWinner));
}

export default {
  id: 'bull',
  title: T('בול פגיעה', 'Bulls & Cows'),
  sub: T('כל אחד בוחר קוד סודי של 4 ספרות שונות', 'Each picks a secret code of 4 different digits'),
  help: [
    T('כל אחד בוחר קוד סודי של 4 ספרות שונות.', 'Each of you picks a secret code of 4 different digits.'),
    T('מנחשים בתורות את הקוד של השני.', 'Take turns guessing the other one\'s code.'),
    T('<b>בול</b> = ספרה נכונה במקום הנכון · <b>פגיעה</b> = ספרה נכונה במקום אחר.', '<b>Bull</b> = right digit in the right place · <b>Cow</b> = right digit in another place.'),
    T('מי שמגיע ראשון ל-4 בולים מנצח (ולשני יש עוד ניסיון אחד להשוות).', 'First to get 4 bulls wins (and the other gets one last try to tie).'),
  ],

  init(starter) {
    return { starter, turn: starter, phase: 'secret', secrets: [null, null], guesses: [[], []], over: null };
  },

  apply(g, a, p) {
    if (a.k === 'secret') {
      if (g.phase !== 'secret' || g.secrets[p] || !valid(a.code)) return false;
      g.secrets[p] = a.code;
      if (g.secrets[0] && g.secrets[1]) g.phase = 'play';
      return true;
    }
    if (a.k === 'guess') {
      if (g.phase !== 'play' || g.turn !== p || !valid(a.code)) return false;
      if (g.guesses[p].some(x => x.code === a.code)) return false;
      g.guesses[p].push({ code: a.code, ...judge(g.secrets[1 - p], a.code) });
      const s0 = solved(g.guesses[0]), s1 = solved(g.guesses[1]);
      // whoever started gets the same number of turns as the other – the other player gets a last chance
      if ((s0 || s1) && g.guesses[0].length === g.guesses[1].length) {
        g.over = { winner: s0 && s1 ? null : (s0 ? 0 : 1) };
      } else g.turn = 1 - p;
      return true;
    }
    return false;
  },

  status(g, { me, other, names }) {
    if (g.phase === 'secret') {
      return g.secrets[me]
        ? { mine: false, text: T(`מחכים ש${names[other]} יבחר/תבחר קוד סודי…`, `Waiting for ${names[other]} to pick a secret code…`) }
        : { mine: true, text: T('כתבו קוד סודי – 4 ספרות שונות 🤫', 'Write a secret code – 4 different digits 🤫') };
    }
    const last = solved(g.guesses[1 - g.turn]);
    if (g.turn === me) return { mine: true, text: last ? T(`${names[other]} פיצח/ה! הזדמנות אחרונה להשוות 😬`, `${names[other]} cracked it! Last chance to tie 😬`) : T('תורך לנחש ✏️', 'Your turn to guess ✏️') };
    return { mine: false, text: last ? T(`פיצחת! ל${names[other]} יש עוד ניסיון אחד להשוות…`, `You cracked it! ${names[other]} gets one last try to tie…`) : T(`התור של ${names[other]}…`, `${names[other]}\'s turn…`) };
  },

  overDetail(g, { me, other, names }) {
    return T(`הקוד של ${names[other]}: ${g.secrets[other]} · הקוד שלי: ${g.secrets[me]}`, `${names[other]}\'s code: ${g.secrets[other]} · my code: ${g.secrets[me]}`);
  },

  render(root, g, ctx) {
    root.replaceChildren();
    sync(g);
    const { me, other, names, send } = ctx;
    const myInk = `var(--ink${me})`, theirInk = `var(--ink${other})`;
    const rerender = () => { root.replaceChildren(); this.render(root, g, ctx); };
    root.style.setProperty('--ink-me', myInk);

    if (g.phase === 'secret') {
      if (!g.secrets[me]) {
        root.append(
          h('p', { class: 'center' }, T(`${names[other]} ינסה/תנסה לנחש אותו. בכל ניחוש יקבל/תקבל:`, `${names[other]} will try to guess it. Each guess gets:`)),
          h('p', { class: 'center soft' }, T('בול = ספרה נכונה במקום הנכון · פגיעה = ספרה נכונה במקום אחר', 'Bull = right digit, right place · Cow = right digit, another place')),
          ...entryBox(rerender, () => { send({ k: 'secret', code: ui.entry }); ui.entry = ''; }, T('זה הקוד! 🔒', 'That\'s my code! 🔒')));
        root.querySelectorAll('.slot').forEach(el => { el.style.color = myInk; });
      } else {
        root.append(h('div', { class: 'card center' },
          h('div', {}, T('הקוד הסודי שלי', 'My secret code')),
          h('div', { class: 'code-big', style: { color: myInk } }, g.secrets[me]),
          h('p', { class: 'soft' }, T('שמרו אותו בסוד! 🤐', 'Keep it secret! 🤐'))));
      }
      return;
    }

    root.append(h('div', { class: 'center soft' }, T('הקוד הסודי שלי: ', 'My secret code: '),
      h('b', { style: { color: myInk, letterSpacing: '4px', direction: 'ltr', display: 'inline-block' } }, g.secrets[me])));

    if (!g.over) {
      // the keypad stays in place (greyed out) while the other player thinks, so the page does not move
      const myTurn = g.turn === me;
      root.append(...entryBox(rerender, () => {
        if (g.guesses[me].some(x => x.code === ui.entry)) { toast(T('את הניחוש הזה כבר ניסית 🙂', 'You already tried that guess 🙂')); ui.entry = ''; rerender(); return; }
        send({ k: 'guess', code: ui.entry }); ui.entry = '';
      }, myTurn ? T('בדוק! 🎯', 'Check! 🎯') : T(`מחכים ל${names[other]}…`, `Waiting for ${names[other]}…`), !myTurn));
      root.querySelectorAll('.slot').forEach(el => { el.style.color = myInk; });
    }

    root.append(h('div', { class: 'cols' },
      guessTable(g.guesses[me], T(`הניחושים שלי על הקוד של ${names[other]}`, `My guesses at ${names[other]}\'s code`), myInk, T('עוד לא ניחשת', 'No guesses yet')),
      guessTable(g.guesses[other], T(`${names[other]} מנחש/ת את הקוד שלי`, `${names[other]} guessing my code`), theirInk, T('עוד אין ניחושים', 'No guesses yet'))));

    // scratch row – tap a digit to cross it out / circle it, just like on paper
    const scratch = h('div', { class: 'scratch' });
    for (const d of '0123456789') {
      const st = ui.scratch[d] || '';
      scratch.append(h('button', {
        class: st,
        onclick: () => { ui.scratch[d] = st === '' ? 'x' : st === 'x' ? 'o' : ''; saveScratch(); rerender(); },
      }, d));
    }
    root.append(h('div', { class: 'card' },
      h('div', { class: 'soft center', style: { fontSize: '14px' } }, T('טיוטה – לחיצה מוחקת ספרה, לחיצה נוספת מקיפה אותה', 'Scratch pad – tap to cross out a digit, tap again to circle it')),
      scratch));
  },
};

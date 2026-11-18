import { h, toast } from '../ui.js';

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
    h('button', { class: 'key wide', disabled: off || !ui.entry, onclick: () => { ui.entry = ui.entry.slice(0, -1); rerender(); } }, '⌫ מחק'),
    h('button', { class: 'key wide action', disabled: off || ui.entry.length !== 4, onclick: onSubmit, style: { gridColumn: 'span 3' } }, submitLabel));
  return [slots, keys];
}

function guessTable(list, title, ink, mineWinner) {
  return h('div', {},
    h('h3', { style: { color: ink } }, title),
    list.length ? h('table', { class: 'paper' },
      h('tr', {}, h('th', {}, '#'), h('th', {}, 'ניחוש'), h('th', {}, 'בול'), h('th', {}, 'פגיעה')),
      list.map((x, i) => h('tr', { class: x.b === 4 ? 'win' : '' },
        h('td', { class: 'soft' }, i + 1),
        h('td', { class: 'code', style: { color: ink } }, x.code),
        h('td', {}, x.b || '–'),
        h('td', {}, x.p || '–'))))
      : h('p', { class: 'soft' }, mineWinner));
}

export default {
  id: 'bull',
  title: 'בול פגיעה',
  sub: 'כל אחד בוחר קוד סודי של 4 ספרות שונות',
  help: [
    'כל אחד בוחר קוד סודי של 4 ספרות שונות.',
    'מנחשים בתורות את הקוד של השני.',
    '<b>בול</b> = ספרה נכונה במקום הנכון · <b>פגיעה</b> = ספרה נכונה במקום אחר.',
    'מי שמגיע ראשון ל-4 בולים מנצח (ולשני יש עוד ניסיון אחד להשוות).',
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
        ? { mine: false, text: `מחכים ש${names[other]} יבחר/תבחר קוד סודי…` }
        : { mine: true, text: 'כתבו קוד סודי – 4 ספרות שונות 🤫' };
    }
    const last = solved(g.guesses[1 - g.turn]);
    if (g.turn === me) return { mine: true, text: last ? `${names[other]} פיצח/ה! הזדמנות אחרונה להשוות 😬` : 'תורך לנחש ✏️' };
    return { mine: false, text: last ? `פיצחת! ל${names[other]} יש עוד ניסיון אחד להשוות…` : `התור של ${names[other]}…` };
  },

  overDetail(g, { me, other, names }) {
    return `הקוד של ${names[other]}: ${g.secrets[other]} · הקוד שלי: ${g.secrets[me]}`;
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
          h('p', { class: 'center' }, `${names[other]} ינסה/תנסה לנחש אותו. בכל ניחוש יקבל/תקבל:`),
          h('p', { class: 'center soft' }, 'בול = ספרה נכונה במקום הנכון · פגיעה = ספרה נכונה במקום אחר'),
          ...entryBox(rerender, () => { send({ k: 'secret', code: ui.entry }); ui.entry = ''; }, 'זה הקוד! 🔒'));
        root.querySelectorAll('.slot').forEach(el => { el.style.color = myInk; });
      } else {
        root.append(h('div', { class: 'card center' },
          h('div', {}, 'הקוד הסודי שלי'),
          h('div', { class: 'code-big', style: { color: myInk } }, g.secrets[me]),
          h('p', { class: 'soft' }, 'שמרו אותו בסוד! 🤐')));
      }
      return;
    }

    root.append(h('div', { class: 'center soft' }, 'הקוד הסודי שלי: ',
      h('b', { style: { color: myInk, letterSpacing: '4px', direction: 'ltr', display: 'inline-block' } }, g.secrets[me])));

    if (!g.over) {
      // the keypad stays in place (greyed out) while the other player thinks, so the page does not move
      const myTurn = g.turn === me;
      root.append(...entryBox(rerender, () => {
        if (g.guesses[me].some(x => x.code === ui.entry)) { toast('את הניחוש הזה כבר ניסית 🙂'); ui.entry = ''; rerender(); return; }
        send({ k: 'guess', code: ui.entry }); ui.entry = '';
      }, myTurn ? 'בדוק! 🎯' : `מחכים ל${names[other]}…`, !myTurn));
      root.querySelectorAll('.slot').forEach(el => { el.style.color = myInk; });
    }

    root.append(h('div', { class: 'cols' },
      guessTable(g.guesses[me], `הניחושים שלי על הקוד של ${names[other]}`, myInk, 'עוד לא ניחשת'),
      guessTable(g.guesses[other], `${names[other]} מנחש/ת את הקוד שלי`, theirInk, 'עוד אין ניחושים')));

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
      h('div', { class: 'soft center', style: { fontSize: '14px' } }, 'טיוטה – לחיצה מוחקת ספרה, לחיצה נוספת מקיפה אותה'),
      scratch));
  },
};

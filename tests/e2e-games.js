// Plays all five games to the end through the real UI on two "phones" (two tabs, local sync),
// reloading a random phone at random moments - every phase must survive a reload.
// Run: node tests/e2e-games.js [baseUrl] [rounds]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8765/';
const ROUNDS = +(process.argv[3] || 2);
const RELOAD_P = 0.12;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const st = p => p.evaluate(() => JSON.parse(JSON.stringify(window.__dv.state)));
const pick = a => a[Math.floor(Math.random() * a.length)];
let reloads = 0;

async function settle(A, B) {
  const t0 = Date.now();
  for (;;) {
    try {
      const [a, b, la, lb] = [await st(A), await st(B), await A.evaluate(() => window.__dv.link), await B.evaluate(() => window.__dv.link)];
      if (a && b && la === 'linked' && lb === 'linked' && JSON.stringify(a) === JSON.stringify(b)) return a;
    } catch (e) { /* page is reloading */ }
    if (Date.now() - t0 > 20000) {
      const d = async p => p.evaluate(() => ({ link: window.__dv.link, rev: window.__dv.state && window.__dv.state.rev, cur: window.__dv.state && window.__dv.state.current, outbox: window.__dv.outbox.length, role: window.__dv.session && window.__dv.session.role })).catch(e => e.message);
      throw new Error('phones did not settle on the same state: ' + JSON.stringify([await d(A), await d(B)]));
    }
    await sleep(40);
  }
}
async function maybeReload(A, B) {
  if (Math.random() > RELOAD_P) return;
  const p = pick([A, B]);
  reloads++;
  await p.reload();
  await p.waitForFunction(() => window.__dv && window.__dv.state);
}
const typeKeys = async (p, str) => { for (const ch of str) await p.click(`.key:text-is("${ch}")`); };
const digits4 = () => { const d = '0123456789'.split(''); let o = ''; for (let i = 0; i < 4; i++) o += d.splice(Math.floor(Math.random() * d.length), 1)[0]; return o; };
const WORDS = [['שלום', 'he'], ['גלידה', 'he'], ['ארץ עיר', 'he'], ['מלך', 'he'], ['CAT', 'en'], ['PAPER', 'en'], ['MY DOG', 'en']];

const drivers = {
  async bull(A, B, s) {
    const pages = [A, B];
    if (s.game.phase === 'secret') {
      const i = s.game.secrets[0] ? 1 : 0;
      await typeKeys(pages[i], digits4()); await pages[i].click('text=זה הקוד!');
      return;
    }
    const t = s.game.turn, p = pages[t];
    let code = Math.random() < 0.3 ? s.game.secrets[1 - t] : digits4();
    while (s.game.guesses[t].some(x => x.code === code)) code = digits4();
    await typeKeys(p, code); await p.click('text=בדוק!');
  },
  async hangman(A, B, s) {
    const pages = [A, B];
    if (s.game.phase === 'word') {
      const i = s.game.words[0] ? 1 : 0, p = pages[i];
      const [w, lang] = pick(WORDS);
      await p.click(lang === 'en' ? 'text=English' : 'text=עברית');
      for (const ch of w) { if (ch === ' ') await p.click('.key:text-is("רווח")'); else await p.click(`.key:text-is("${ch}")`); }
      if (Math.random() < .5) await p.fill('input.paper', 'רמז קטן');
      await p.click('text=זאת המילה!');
      return;
    }
    const t = s.game.turn, p = pages[t];
    const target = s.game.words[1 - t];
    if (Math.random() < 0.08) { // try the whole word (right or wrong)
      await p.click('text=יודע/ת את כל המילה');
      const guess = Math.random() < .5 ? target.text : (target.lang === 'en' ? 'XQ' : 'זט');
      for (const ch of guess) { if (ch === ' ') await p.click('.card .key:text-is("רווח")'); else await p.click(`.card .key:text-is("${ch}")`); }
      await p.click('.card >> text=זאת המילה!');
      return;
    }
    const keys = await p.$$('.keys .key:not([disabled])');
    await pick(keys).click();
  },
  async ships(A, B, s) {
    const pages = [A, B];
    if (s.game.phase === 'place') {
      const i = s.game.layouts[0] ? 1 : 0, p = pages[i];
      if (Math.random() < .5) { // place one by hand first
        await p.click('.board .cell >> nth=0'); await p.click('text=סיבוב');
      }
      await p.click('text=אקראי'); await p.click('text=מוכן!');
      return;
    }
    const p = pages[s.game.turn];
    const cells = await p.$$('.board:not(.small) .cell.hot');
    await pick(cells).click();
    if (Math.random() < .5) await p.click('text=אש על'); else await p.click('.board:not(.small) .cell.sel');
  },
  async dots(A, B, s) {
    const p = [A, B][s.game.turn];
    const polys = await p.$$('.dots-svg polygon');
    await pick(polys).click({ force: true });
  },
  async five(A, B, s) {
    const p = [A, B][s.game.turn];
    const free = []; s.game.cells.forEach((v, i) => { if (v < 0) free.push(i); });
    const near = free.filter(i => Math.abs(Math.floor(i / 21) - 10) < 3 && Math.abs(i % 21 - 10) < 3);
    const i = pick(near.length ? near : free), r = Math.floor(i / 21), c = i % 21;
    // a person waits for the sheet to stop sliding to the other player's mark before tapping
    await p.evaluate(() => new Promise(res => {
      const w = document.querySelector('.five-wrap'); let last = [-1, -1], still = 0;
      const t = setInterval(() => { if (w.scrollLeft === last[0] && w.scrollTop === last[1]) { if (++still >= 3) { clearInterval(t); res(); } } else { still = 0; last = [w.scrollLeft, w.scrollTop]; } }, 40);
    }));
    for (let k = 0; k < 2; k++) {
      // scroll the cell into view like a finger would, then tap it
      await p.evaluate(([r, c]) => {
        const w = document.querySelector('.five-wrap'), b = document.querySelector('.five-board');
        const cell = b.clientWidth / 21;
        w.scrollLeft = (c + .5) * cell - w.clientWidth / 2; w.scrollTop = (r + .5) * cell - w.clientHeight / 2;
      }, [r, c]);
      await sleep(30);
      const bb = await (await p.$('.five-board')).boundingBox();
      const cell = bb.width / 21;
      await p.mouse.click(bb.x + (c + .5) * cell, bb.y + (r + .5) * cell);
      await sleep(30);
    }
  },
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const A = await ctx.newPage(), B = await ctx.newPage();
  const errs = [];
  for (const [n, p] of [['A', A], ['B', B]]) {
    p.on('pageerror', e => errs.push(n + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(n + ' console: ' + m.text()); });
  }
  await A.goto(BASE + '?local=host'); await A.fill('input.paper', 'אבא'); await A.click('text=פותחים דף חדש');
  const code = (await A.textContent('.code-big')).trim();
  await B.goto(BASE + `?local=guest&room=${code}`); await B.fill('input.paper', 'נועה'); await B.click('text=הצטרפות ✏️');
  let s = await settle(A, B);
  const order = ['bull', 'hangman', 'ships', 'dots', 'five'];
  let played = 0, replays = 0;
  const NEXT = 'button[data-log^="next:"]';
  for (let round = 0; round < ROUNDS; round++) {
    for (let gi = 0; gi < order.length; gi++) {
      const id = order[gi];
      s = await settle(A, B);
      if (s.series.results.length !== gi) throw new Error(`series has ${s.series.results.length} results before game ${gi + 1}`);
      // the only way forward is the "next game" button – on the table or on the result card, on either phone
      const starter = pick([A, B]);
      await starter.click(NEXT);
      let steps = 0, replayed = false;
      for (;;) {
        s = await settle(A, B);
        if (s.current !== id) { await sleep(150); s = await settle(A, B); }
        if (s.current !== id) throw new Error(`expected ${id}, phones show ${s.current}`);
        if (s.game.over) {
          // now and then somebody is not happy and asks for a replay: the result must disappear
          if (!replayed && Math.random() < 0.25) {
            replayed = true; replays++;
            const p = pick([A, B]);
            await p.click('button[data-log="replay"]'); await p.click('.modal >> text=כן, משחק חוזר');
            await sleep(200);
            s = await settle(A, B);
            if (s.game.over || s.series.results.length !== gi) throw new Error('replay did not erase the result');
            continue;
          }
          break;
        }
        if (++steps > 500) throw new Error(id + ' does not end');
        await drivers[id](A, B, s);
        const rev = s.rev; const t0 = Date.now();
        while ((await st(A)).rev === rev) {
          if (Date.now() - t0 > 8000) throw new Error(`${id}: action had no effect (step ${steps}, phase ${s.game.phase || ''}, turn ${s.game.turn})`);
          await sleep(30);
        }
        await maybeReload(A, B);
      }
      played++;
      await A.waitForSelector('.result'); await B.waitForSelector('.result');
      if (s.series.results.length !== gi + 1) throw new Error(`series has ${s.series.results.length} results after game ${gi + 1}`);
      const dec = s.series.results.filter(r => r.winner === 0).length >= 3 || s.series.results.filter(r => r.winner === 1).length >= 3;
      // a verdict is shown once somebody has three wins, and in any case after the fifth game
      if ((dec || s.series.results.length === 5) !== !!(await A.$('.verdict'))) throw new Error('series verdict on screen does not match the score');
      console.log(`  ${id.padEnd(8)} finished in ${String(steps).padStart(3)} steps, winner: ${s.game.over.winner === null ? 'tie' : s.players[s.game.over.winner].name}${replayed ? ' (after a replay)' : ''}`);
    }
    // five games done: no "next game" any more, only a new series
    if (await A.$(NEXT)) throw new Error('a sixth game is offered');
    const ev0 = s.evening.reduce((a, b) => a + b, 0);
    await pick([A, B]).click('button[data-log="new-series"]');
    await sleep(200);
    s = await settle(A, B);
    if (s.series.n !== round + 2 || s.series.results.length || s.evening.reduce((a, b) => a + b, 0) !== ev0 + 1) throw new Error('new series did not start cleanly');
    console.log(`  -- series ${round + 1} closed, evening: ${JSON.stringify(s.evening)}`);
  }
  const tallyA = await A.$$eval('.tally path', els => els.length), tallyB = await B.$$eval('.tally path', els => els.length);
  if (tallyA !== tallyB || !tallyA) throw new Error('evening tally marks differ between phones');
  console.log(`played ${played} games (+${replays} replays) with ${reloads} random reloads`);
  console.log('script errors:', errs.length ? '\n' + errs.join('\n') : 'none');
  await browser.close();
  process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

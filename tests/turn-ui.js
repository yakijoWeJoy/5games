// Whose turn / sound / "how to play" – on two phones (two tabs, local sync).
// Run: node tests/turn-ui.js [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8765/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const sounds = p => p.evaluate(() => (window.__dvSounds || []).slice());
const look = p => p.evaluate(() => ({
  mine: document.body.classList.contains('my-turn'),
  wait: document.body.classList.contains('their-turn'),
  banner: document.querySelector('.turn.mine') ? 'mine' : document.querySelector('.turn.wait') ? 'wait' : 'none',
  dim: !!document.querySelector('.body-slot.wait'),
  title: document.title,
  holder: (document.querySelector('.ptag.holder .pname') || {}).textContent || null,
  help: !!document.querySelector('.help-card'),
}));
const settle = async (A, B) => {
  const t0 = Date.now();
  for (;;) {
    const [a, b] = await Promise.all([A, B].map(p => p.evaluate(() => JSON.stringify(window.__dv.state)).catch(() => null)));
    if (a && a === b) return JSON.parse(a);
    if (Date.now() - t0 > 15000) throw new Error('phones did not agree');
    await sleep(60);
  }
};
const lineBy = async p => { const polys = await p.$$('.dots-svg polygon'); await polys[0].click({ force: true }); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript(() => { window.__dvTest = true; });
  const A = await ctx.newPage(), B = await ctx.newPage();
  const errs = [];
  for (const [n, p] of [['A', A], ['B', B]]) p.on('pageerror', e => errs.push(n + ': ' + e.message));
  await A.goto(BASE + '?local=host'); await A.fill('input.paper', 'אבא'); await A.click('text=פותחים דף חדש');
  const code = (await A.textContent('.code-big')).trim();
  await B.goto(BASE + `?local=guest&room=${code}`); await B.fill('input.paper', 'נועה'); await B.click('text=הצטרפות ✏️');
  await A.waitForSelector('.game-row'); await B.waitForSelector('.game-row');
  check((await sounds(A)).includes('join'), 'host hears a sound when the partner joins');

  // ----- the first game of the series: the "how to play" card opens on both phones -----
  await A.click('button[data-log^="next:"]');
  await A.waitForSelector('.help-card'); await B.waitForSelector('.help-card');
  const helpText = await A.textContent('.help-card');
  check(/בול/.test(helpText) && /פגיעה/.test(helpText), '"how to play" opens by itself the first time, and explains the game');
  await A.click('.help-card >> text=הבנתי'); await B.click('.help-card >> text=הבנתי');
  check(!(await A.$('.help-card')), '"got it" closes it');
  await A.reload(); await A.waitForSelector('.turn'); await sleep(400);
  check(!(await A.$('.help-card')), 'it does not come back after a reload');
  await A.click('.help-btn');
  check(!!(await A.$('.help-card')), 'the "?" button opens it again at any time');
  await A.click('.help-card >> text=הבנתי');

  // ----- both choose a secret at the same time: no pencil in the header, both "mine" -----
  let la = await look(A), lb = await look(B);
  if (!(la.banner === 'mine' && lb.banner === 'mine' && la.holder === null)) console.log('   A', JSON.stringify(la), '\n   B', JSON.stringify(lb));
  check(la.banner === 'mine' && lb.banner === 'mine' && la.holder === null, 'both write a secret at once: both see "your move", nobody holds the pencil');

  // ----- leave bull, go to dots via the test shortcut (alternating single moves are easy to drive) -----
  await A.evaluate(() => window.__dv.act({ k: 'jump', game: 'dots' }));
  await settle(A, B);
  await A.waitForSelector('.dots-svg'); await B.waitForSelector('.dots-svg');
  await sleep(200);
  for (const p of [A, B]) if (await p.$('.help-card')) await p.click('.help-card >> text=הבנתי');
  let s = await settle(A, B);
  const P = [A, B], first = P[s.game.turn], second = P[1 - s.game.turn];
  const firstName = s.players[s.game.turn].name, secondName = s.players[1 - s.game.turn].name;
  la = await look(first); lb = await look(second);
  check(la.mine && !la.wait && la.banner === 'mine' && !la.dim && la.title.startsWith('✏️'), 'my turn: frame on, banner "mine", board bright, tab title says ✏️ תורך');
  check(lb.wait && !lb.mine && lb.banner === 'wait' && lb.dim && !lb.title.startsWith('✏️'), 'their turn: no frame, banner "waiting", board dimmed, plain tab title');
  check(la.holder === firstName && lb.holder === firstName, 'both headers put the pencil next to the same (right) player');

  // ----- a move hands the pencil over: sound + look switch on the other phone -----
  const before = (await sounds(second)).filter(x => x === 'turn').length;
  const beforeFirst = (await sounds(first)).filter(x => x === 'turn').length;
  await lineBy(first);
  await settle(A, B); await sleep(150);
  la = await look(first); lb = await look(second);
  check(lb.mine && la.wait, 'after a move the look switches on both phones');
  check(la.holder === secondName && lb.holder === secondName, 'the pencil moved to the other name');
  check((await sounds(second)).filter(x => x === 'turn').length === before + 1, 'the phone whose turn it now is plays the "your turn" sound exactly once');
  check((await sounds(first)).filter(x => x === 'turn').length === beforeFirst, 'the phone that just played does not ding');

  // ----- mute: no sound, setting survives a reload -----
  await first.click('.sound-btn');
  check(!(await first.evaluate(() => localStorage.getItem('dv:sound') !== 'off')), 'the 🔔 button mutes');
  await first.reload(); await first.waitForSelector('.dots-svg');
  check((await first.textContent('.sound-btn')).includes('🔕'), 'mute is remembered after a reload');
  const mutedBefore = (await sounds(first)).length;
  await lineBy(second);
  await settle(A, B); await sleep(150);
  const after = (await sounds(first)).slice(mutedBefore);
  check(after.length === 1 && after[0] === 'turn:muted', 'muted phone makes no sound when the turn comes (and nothing else is played)');
  check((await look(first)).mine, '...but the visual "your turn" still shows');
  await first.click('.sound-btn');
  check((await sounds(first)).slice(-1)[0] === 'turn', 'turning sound back on plays a sample');

  // ----- a reload in the middle of my turn does not ding again -----
  const pre = (await sounds(first)).length;
  await first.reload(); await first.waitForSelector('.dots-svg'); await sleep(500);
  check(!(await first.evaluate(() => (window.__dvSounds || []).includes('turn'))), 'opening the page in the middle of my turn does not ding');
  void pre;

  // ----- end of game: win / lose tunes -----
  await A.evaluate(() => window.__dv.act({ k: 'jump', game: 'five' }));
  s = await settle(A, B);
  for (const p of [A, B]) { await p.waitForSelector('.five-board'); if (await p.$('.help-card')) await p.click('.help-card >> text=הבנתי'); }
  const w = s.game.turn, wp = P[w], lp = P[1 - w];
  for (let k = 0; k < 5; k++) {
    await wp.evaluate(i => window.__dv.act({ k: 'g', a: { k: 'put', i } }), 10 * 21 + 5 + k); await settle(A, B);
    if (k < 4) { await lp.evaluate(i => window.__dv.act({ k: 'g', a: { k: 'put', i } }), 14 * 21 + 5 + k); await settle(A, B); }
  }
  await sleep(200);
  check((await sounds(wp)).slice(-1)[0] === 'win' && (await sounds(lp)).slice(-1)[0] === 'lose', 'the winner hears a win tune, the other a softer one');
  la = await look(A);
  check(!la.mine && !la.wait && !la.title.startsWith('✏️'), 'after the game the turn frame / title are cleared');
  await wp.reload(); await wp.waitForSelector('.result'); await sleep(300);
  check(!(await wp.evaluate(() => (window.__dvSounds || []).includes('win'))), 'reopening a finished game does not replay the tune');

  // ----- the card appears once per game per phone, not again in later series -----
  await A.click('.result >> text=לטבלה'); await A.waitForSelector('.game-row');
  await A.click('button[data-log="new-series"]').catch(() => {});
  if (await A.$('.modal')) await A.click('.modal >> text=כן, סדרה חדשה');
  await A.waitForSelector('button[data-log^="next:"]'); await A.click('button[data-log^="next:"]');
  await sleep(600);
  check(!(await A.$('.help-card')) && !(await B.$('.help-card')), 'next time the same game starts, the card stays closed');

  check(!errs.length, 'no script errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall turn / sound / help checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASH', e.message); process.exit(2); });

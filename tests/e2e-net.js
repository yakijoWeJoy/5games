// Disconnect / reconnect scenarios over the real PeerJS connection.
// Run: node tests/e2e-net.js [baseUrl]   (needs playwright; serve the repo, e.g. python3 -m http.server 8765)
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8765/';
// MODE: relay  = relay servers only (two phones on mobile data that cannot reach each other directly)
//       both   = relay + direct
//       direct = no relay server reachable, direct WebRTC only
//       half   = one relay server is dead, one works
//       live   = whatever the site really uses (public relay servers)
const MODE = process.env.MODE || 'relay';
const B1 = { name: 't1', host: 'localhost', port: 9101, path: '/', ssl: false };
const B2 = { name: 't2', host: 'localhost', port: 9102, path: '/', ssl: false };
const DEADB = { name: 'dead', host: 'localhost', port: 9199, path: '/', ssl: false };
const CFG = { relay: { brokers: [B1, B2], noDirect: true }, both: { brokers: [B1, B2] }, direct: { brokers: [DEADB], noDirect: false }, half: { brokers: [DEADB, B2], noDirect: true }, live: null }[MODE];
const LINK_T = 60000;
const results = [];
let browser;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const st = p => p.evaluate(() => JSON.parse(JSON.stringify(window.__dv.state)));
const linked = (p, t = LINK_T) => p.waitForFunction(() => window.__dv && window.__dv.link === 'linked', null, { timeout: t });
const lines = s => s.game.h.flat().concat(s.game.v.flat()).filter(x => x >= 0).length;
const watch = (p, name, errs) => {
  p.on('pageerror', e => errs.push(`${name}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket|ERR_INTERNET|net::ERR/.test(m.text())) errs.push(`${name} console: ${m.text()}`); });
};
async function same(A, B, t = 15000) {
  const t0 = Date.now();
  for (;;) {
    const [a, b] = [await st(A), await st(B)];
    if (JSON.stringify(a) === JSON.stringify(b)) return a;
    if (Date.now() - t0 > t) throw new Error(`states differ: host rev ${a && a.rev} guest rev ${b && b.rev}`);
    await sleep(200);
  }
}
/** whoever's turn it is draws one random line; both phones must then show exactly one more line */
async function move(A, B, who) {
  const before = lines(await same(A, B));
  let p = (await A.$('.turn.mine')) ? A : B;
  if (who && who !== p) { await clickLine(p); await sleep(300); const s = await same(A, B); p = s.game.turn === 0 ? A : B; if (p !== who) return move(A, B, who); return move(A, B, who); }
  await clickLine(p);
  const t0 = Date.now();
  for (;;) {
    const s = await same(A, B);
    if (lines(s) === before + 1) return s;
    if (lines(s) > before + 1) throw new Error('more than one line was added');
    if (Date.now() - t0 > 15000) throw new Error('move did not arrive');
    await sleep(150);
  }
}
async function clickLine(p) {
  await p.waitForSelector('.turn.mine', { timeout: 15000 });
  await p.waitForSelector('.dots-svg polygon', { timeout: 15000 });
  const polys = await p.$$('.dots-svg polygon');
  await polys[Math.floor(Math.random() * polys.length)].click({ force: true });
}
async function turnOf(A, B, want) {
  // make moves until it is `want`'s turn
  for (let i = 0; i < 20; i++) {
    const s = await same(A, B);
    if ((s.game.turn === 0 ? A : B) === want) return;
    await move(A, B);
  }
  throw new Error('could not hand the turn over');
}
// the series is played in order, so the tests use a test-only shortcut straight to the dots game (host only)
const startDots = host => host.evaluate(() => window.__dv.act({ k: 'jump', game: 'dots' }));
async function newCtx() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (!CFG) await ctx.addInitScript(() => { window.__dvLogTopic = 'dv5g-selftest-ci'; }); // keep test runs out of the real log
  await ctx.addInitScript(() => { window.__dvTest = true; window.__dvNoHelp = true; });
  if (CFG) await ctx.addInitScript(cfg => { window.__dvBrokers = cfg.brokers; if (cfg.noDirect) window.__dvNoDirect = true; }, CFG);
  return ctx;
}
/** cut a phone off from everything (in and out) without it noticing, like a dead zone */
const mute = p => p.evaluate(() => { const n = window.__dv.net; n.__rx = n.receive; n.receive = () => {}; for (const c of n.channels) { c.__tx = c.send; c.send = () => true; } });
const unmute = p => p.evaluate(() => { const n = window.__dv.net; if (n.__rx) { n.receive = n.__rx; n.__rx = null; } for (const c of n.channels) if (c.__tx) { c.send = c.__tx; c.__tx = null; } });
async function host(ctx, name, errs, tag) {
  const A = await ctx.newPage(); watch(A, tag || 'host', errs);
  await A.goto(BASE); await A.fill('input.paper', name); await A.click('text=פותחים דף חדש');
  await A.waitForSelector('.code-big');
  return [A, (await A.textContent('.code-big')).trim()];
}
async function join(ctx, code, name, errs, tag) {
  const B = await ctx.newPage(); watch(B, tag || 'guest', errs);
  await B.goto(BASE + '?room=' + code); await B.fill('input.paper', name); await B.click('text=הצטרפות ✏️');
  return B;
}
async function scenario(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}: ${e.message.split('\n').slice(0, 12).join(' | ')}`); }
}

(async () => {
  browser = await chromium.launch();
  const errs = [];
  console.log('MODE', MODE);
  const cA = await newCtx(), cB = await newCtx();
  let [A, code] = await host(cA, 'אבא', errs);
  let B = await join(cB, code, 'נועה', errs);

  await scenario('01 join + start a game', async () => {
    await linked(B); await linked(A);
    await startDots(A);
    await B.waitForSelector('.dots-svg');
    await move(A, B); await move(A, B);
  });

  await scenario('02 guest reloads mid-game', async () => {
    const before = await same(A, B);
    await B.reload(); await linked(B); await linked(A);
    const after = await same(A, B);
    if (lines(after) !== lines(before) || after.game.id !== before.game.id) throw new Error('game changed after reload');
    await B.waitForSelector('.dots-svg');
    await move(A, B); await move(A, B);
  });

  await scenario('03 host reloads mid-game', async () => {
    const before = await same(A, B);
    await A.reload();
    await A.waitForSelector('.dots-svg');
    if (lines(await st(A)) !== lines(before)) throw new Error('host lost the game on reload');
    await linked(A); await linked(B);
    await move(A, B); await move(A, B);
  });

  await scenario('04 guest closes the tab and comes back through the link', async () => {
    await B.close();
    await A.waitForFunction(() => window.__dv.link !== 'linked', null, { timeout: 30000 });
    await A.waitForSelector('.note.warn');
    B = await cB.newPage(); watch(B, 'guest', errs);
    await B.goto(BASE + '?room=' + code);
    await linked(B); await linked(A);
    await B.waitForSelector('.dots-svg');
    await move(A, B);
  });

  await scenario('05 host plays while the guest is away; guest catches up', async () => {
    await turnOf(A, B, A);
    await B.close();
    await A.waitForFunction(() => window.__dv.link !== 'linked', null, { timeout: 30000 });
    const before = lines(await st(A));
    await clickLine(A);
    await A.waitForFunction(n => { const g = window.__dv.state.game; return g.h.flat().concat(g.v.flat()).filter(x => x >= 0).length === n; }, before + 1);
    B = await cB.newPage(); watch(B, 'guest', errs);
    await B.goto(BASE); // comes back without the link – the saved session resumes
    await linked(B); await linked(A);
    const s = await same(A, B);
    if (lines(s) !== before + 1) throw new Error('guest did not get the move made while away');
  });

  await scenario('06 host closes the tab and comes back', async () => {
    const before = await same(A, B);
    await A.close();
    await B.waitForFunction(() => window.__dv.link !== 'linked', null, { timeout: 30000 });
    // the guest cannot move while the host is away, and is told so
    const n0 = await B.evaluate(() => window.__dv.outbox.length);
    if (await B.$('.turn.mine')) { await clickLineNoWait(B); await sleep(300); }
    if ((await B.evaluate(() => window.__dv.outbox.length)) !== n0) throw new Error('action queued while offline');
    A = await cA.newPage(); watch(A, 'host', errs);
    await A.goto(BASE);
    await linked(A); await linked(B);
    const s = await same(A, B);
    if (lines(s) !== lines(before)) throw new Error('state changed across host restart');
    await move(A, B); await move(A, B);
  });

  await scenario('07 both phones reload at the same moment', async () => {
    const before = await same(A, B);
    await Promise.all([A.reload(), B.reload()]);
    await linked(A); await linked(B);
    const s = await same(A, B);
    if (lines(s) !== lines(before)) throw new Error('state changed');
    await move(A, B); await move(A, B);
  });

  await scenario('08 connection dies silently; a move made in the dead window arrives exactly once', async () => {
    await turnOf(A, B, B);
    const before = lines(await same(A, B));
    // the guest walks into a dead zone: nothing gets in or out, and nobody is told
    await mute(B);
    await clickLine(B); // still looks connected -> goes to the outbox
    await sleep(500);
    if ((await B.evaluate(() => window.__dv.outbox.length)) !== 1) throw new Error('move was not kept in the outbox');
    await B.waitForFunction(() => window.__dv.link !== 'linked', null, { timeout: 30000 });
    await A.waitForFunction(() => window.__dv.link !== 'linked', null, { timeout: 30000 });
    await unmute(B);
    await linked(B); await linked(A);
    const t0 = Date.now();
    for (;;) {
      const s = await same(A, B);
      if (lines(s) === before + 1) break;
      if (lines(s) > before + 1) throw new Error('move applied twice');
      if (Date.now() - t0 > 20000) throw new Error('queued move never arrived');
      await sleep(200);
    }
    await sleep(3500); // give any late re-send a chance to do damage
    const s = await same(A, B);
    if (lines(s) !== before + 1) throw new Error('move applied twice (late)');
    if ((await B.evaluate(() => window.__dv.outbox.length)) !== 0) throw new Error('outbox not cleared');
    await move(A, B);
  });

  await scenario('09 host side goes deaf (phone asleep) and wakes up', async () => {
    await mute(A);
    await B.waitForFunction(() => window.__dv.link !== 'linked', null, { timeout: 30000 });
    await sleep(4000);
    await unmute(A);
    await linked(B); await linked(A);
    await move(A, B); await move(A, B);
  });

  await scenario('10 duplicated and stale messages are ignored', async () => {
    const s0 = await same(A, B);
    await B.evaluate(() => { const m = { t: 'act', id: 'dup-1', a: { k: 'chat', text: 'פעם אחת' } }; window.__dv.net.send(m); window.__dv.net.send(m); window.__dv.net.send(m); });
    await sleep(1000);
    let s = await same(A, B);
    if (s.chat.length !== s0.chat.length + 1) throw new Error(`chat delivered ${s.chat.length - s0.chat.length} times`);
    // a move addressed to another game, a move out of turn, and nonsense
    await B.evaluate(() => {
      const n = window.__dv.net;
      n.send({ t: 'act', id: 'stale-1', a: { k: 'g', gid: 'not-this-game', a: { k: 'line', o: 'h', r: 0, c: 0 } } });
      n.send({ t: 'act', id: 'junk-1', a: null });
      n.send({ t: 'act' }); n.send('boo'); n.send(42); n.send([]); for (const c of n.channels) { c.send('not json'); c.send('{"i":"x1","r":"g","f":"zz","d":{"t":"act","a":{"k":"menu"}}}'); c.send('{"i":"x2","r":"g","f":"zz","k":"wrong-token","d":{"t":"act","a":{"k":"menu"}}}'); } n.send({ t: 'state', s: { rev: 999 } }); n.send({ t: 'hello' });
      n.send({ t: 'act', id: 'next-stale', a: { k: 'next', from: 'old-game' } }); n.send({ t: 'act', id: 'ns-stale', a: { k: 'newSeries', n: 99 } });
    });
    await sleep(1200);
    s = await same(A, B);
    if (lines(s) !== lines(s0) || s.current !== 'dots' || s.game.id !== s0.game.id) throw new Error('stale/junk message changed the game');
    await move(A, B);
  });

  let C, cC;
  await scenario('11 a third phone cannot barge in', async () => {
    cC = await newCtx();
    C = await join(cC, code, 'פולש', errs, 'third');
    await C.waitForFunction(() => window.__dv.link === 'full', null, { timeout: LINK_T });
    await sleep(1500);
    const s = await same(A, B);
    if (s.players[1].name !== 'נועה') throw new Error('guest was replaced');
    if (await A.evaluate(() => window.__dv.link) !== 'linked') throw new Error('host lost the real guest');
    await move(A, B);
  });

  await scenario('12 "replace partner": the new phone gets in, the old one is told the page is full', async () => {
    await A.click('button[data-log="to-table"]'); await A.click('text=כן, לטבלה');
    await A.click('text=החלפת שותף'); await A.click('.modal >> text=כן');
    await C.click('button:has-text("לנסות שוב")');
    await linked(C);
    await B.waitForFunction(() => window.__dv.link === 'full', null, { timeout: LINK_T });
    const s = await same(A, C);
    if (s.players[1].name !== 'פולש') throw new Error('new partner not registered');
    await startDots(A); await A.waitForSelector('.dots-svg');
    await move(A, C); await move(A, C);
    await sleep(6000); // the old phone must stay out
    if (await B.evaluate(() => window.__dv.link) !== 'full') throw new Error('old phone came back');
    if (await A.evaluate(() => window.__dv.link) !== 'linked') throw new Error('host lost the new partner');
    await move(A, C);
  });

  await scenario('13 network goes down and comes back (guest)', async () => {
    await cC.setOffline(true);
    await sleep(16000);
    await cC.setOffline(false);
    await linked(C); await linked(A);
    await move(A, C); await move(A, C);
  });

  await scenario('14 network goes down and comes back (host)', async () => {
    await cA.setOffline(true);
    await sleep(16000);
    await cA.setOffline(false);
    await linked(C); await linked(A);
    await move(A, C); await move(A, C);
  });

  await scenario('15 guest leaves the page for good; host is told; guest lands on the home screen', async () => {
    await B.click('text=יציאה מהדף'); await B.click('.modal >> text=יציאה');
    await B.waitForSelector('text=פותחים דף חדש');
    if (await B.evaluate(() => window.__dv.session) !== null) throw new Error('session not cleared');
    await B.reload(); await B.waitForSelector('text=פותחים דף חדש');
  });

  await scenario('16 wrong code: clear message and a way out', async () => {
    const cX = await newCtx();
    const X = await join(cX, '0000', 'תועה', errs, 'lost');
    await X.waitForFunction(() => window.__dv.link === 'no-host', null, { timeout: LINK_T });
    await X.waitForSelector('.note.warn');
    await X.click('text=ביטול');
    await X.waitForSelector('text=פותחים דף חדש');
    await cX.close();
  });

  await scenario('17 two tabs in the same browser can play each other', async () => {
    const cD = await newCtx();
    const [D1, code2] = await host(cD, 'לשונית1', errs, 'tab1');
    const D2 = await cD.newPage(); watch(D2, 'tab2', errs);
    await D2.goto(BASE + '?room=' + code2);
    await D2.waitForSelector('text=הוזמנת לשחק'); // must NOT resume as a second host
    await D2.fill('input.paper', 'לשונית2'); await D2.click('text=הצטרפות ✏️');
    await linked(D2); await linked(D1);
    await startDots(D1); await D2.waitForSelector('.dots-svg');
    await move(D1, D2);
    await D2.reload(); await linked(D2); await linked(D1);
    await D1.reload(); await linked(D1); await linked(D2);
    const s = await same(D1, D2);
    if (await D1.evaluate(() => window.__dv.session.role) !== 'host' || await D2.evaluate(() => window.__dv.session.role) !== 'guest') throw new Error('roles got mixed');
    if (s.players[0].name !== 'לשונית1' || s.players[1].name !== 'לשונית2') throw new Error('names mixed');
    await move(D1, D2);
    await cD.close();
  });

  await scenario('18 two families get the same code: the second one silently gets another', async () => {
    const cE = await newCtx(), cF = await newCtx();
    await cE.addInitScript(() => { window.__dvForceCode = '4242'; });
    await cF.addInitScript(() => { if (!sessionStorage.getItem('forced')) { sessionStorage.setItem('forced', '1'); window.__dvForceCode = '4242'; } });
    const [E, c1] = await host(cE, 'משפחה1', errs, 'fam1');
    await E.waitForFunction(() => (window.__dv.net.anyOpen() || window.__dv.net.channels.some(c => c.signal)), null, { timeout: LINK_T }); await sleep(9000); // no longer 'fresh'
    const [F] = await host(cF, 'משפחה2', errs, 'fam2');
    await F.waitForFunction(() => window.__dv.session.code !== '4242' && (window.__dv.net.anyOpen() || window.__dv.net.channels.some(c => c.signal)), null, { timeout: LINK_T });
    const c2 = await F.evaluate(() => window.__dv.session.code);
    if (c1 !== '4242' || (await F.textContent('.code-big')).trim() !== c2) throw new Error('code not refreshed on screen');
    const cG = await newCtx();
    const G = await join(cG, c2, 'אורח2', errs, 'fam2-guest');
    await linked(G); await linked(F);
    if (await E.evaluate(() => window.__dv.state.players[1].token) !== null) throw new Error('guest landed in the wrong family');
    await cE.close(); await cF.close(); await cG.close();
  });

  await scenario('19 full state agreement at the end + no script errors', async () => {
    await same(A, C);
    if (errs.length) throw new Error('script errors:\n' + errs.join('\n'));
  });

  const failed = results.filter(r => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); try { await browser.close(); } catch { /* ignore */ } process.exit(2); });

async function clickLineNoWait(p) {
  const polys = await p.$$('.dots-svg polygon');
  if (polys.length) await polys[0].click({ force: true });
}

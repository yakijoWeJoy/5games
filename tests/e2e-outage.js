// Relay server outage in the middle of a game (relay-only, like two phones on mobile data):
//  1. one of two relay servers dies  -> nobody notices, play continues
//  2. the last relay server dies      -> both phones show the "no connection" help
//  3. a relay server comes back       -> phones re-link by themselves, the game continues
// Needs the same modules as tests/local-broker.js.  Run: node tests/e2e-outage.js [baseUrl]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:8765/';
const P1 = 9111, P2 = 9112;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const startBroker = port => spawn(process.execPath, [path.join(__dirname, 'local-broker.js'), String(port)], { stdio: 'ignore', env: process.env });
const st = p => p.evaluate(() => JSON.parse(JSON.stringify(window.__dv.state)));
const linked = p => p.waitForFunction(() => window.__dv.link === 'linked', null, { timeout: 60000 });
const lines = s => s.game.h.flat().concat(s.game.v.flat()).filter(x => x >= 0).length;

async function move(A, B) {
  const before = lines(await st(A));
  const p = (await A.$('.turn.mine')) ? A : B;
  await p.waitForSelector('.dots-svg polygon');
  const polys = await p.$$('.dots-svg polygon');
  await polys[Math.floor(Math.random() * polys.length)].click({ force: true });
  const t0 = Date.now();
  for (;;) {
    const [a, b] = [await st(A), await st(B)];
    if (lines(a) === before + 1 && JSON.stringify(a) === JSON.stringify(b)) return;
    if (Date.now() - t0 > 15000) throw new Error('move did not reach both phones');
    await sleep(150);
  }
}

(async () => {
  let b1 = startBroker(P1), b2 = startBroker(P2);
  await sleep(1200);
  const browser = await chromium.launch();
  const errs = [];
  const mk = async name => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c.addInitScript(ports => { window.__dvBrokers = ports.map((port, i) => ({ name: 't' + i, host: 'localhost', port, path: '/', ssl: false })); window.__dvNoDirect = true; }, [P1, P2]);
    const p = await c.newPage();
    p.on('pageerror', e => errs.push(name + ': ' + e.message));
    return p;
  };
  const A = await mk('host'), B = await mk('guest');
  let ok = true;
  const step = async (name, fn) => { try { await fn(); console.log('PASS ', name); } catch (e) { ok = false; console.log('FAIL ', name + ': ' + e.message.split('\n')[0]); } };
  try {
    await A.goto(BASE); await A.fill('input.paper', 'אבא'); await A.click('text=פותחים דף חדש');
    const code = (await A.textContent('.code-big')).trim();
    await B.goto(BASE + '?room=' + code); await B.fill('input.paper', 'נועה'); await B.click('text=הצטרפות ✏️');
    await linked(A); await linked(B);
    await A.click('.game-row >> nth=3'); await B.waitForSelector('.dots-svg');
    await move(A, B);

    await step('one of two relay servers dies: play continues without a hiccup', async () => {
      b1.kill(); await sleep(2500);
      for (let i = 0; i < 4; i++) await move(A, B);
      if (await A.evaluate(() => window.__dv.link) !== 'linked' || await B.evaluate(() => window.__dv.link) !== 'linked') throw new Error('link dropped');
    });

    await step('all relay servers die: both phones explain what is going on', async () => {
      b2.kill();
      await A.waitForFunction(() => window.__dv.link !== 'linked', null, { timeout: 40000 });
      await B.waitForFunction(() => window.__dv.link !== 'linked', null, { timeout: 40000 });
      await A.waitForSelector('.conn'); await B.waitForSelector('.conn');
      await B.waitForFunction(() => window.__dv.link === 'offline', null, { timeout: 30000 });
    });

    await step('a relay server comes back: phones re-link on their own and the game goes on', async () => {
      const before = lines(await st(A));
      b1 = startBroker(P1);
      await linked(A); await linked(B);
      if (lines(await st(B)) !== before) throw new Error('game changed during the outage');
      for (let i = 0; i < 3; i++) await move(A, B);
    });

    await step('"try again" button reconnects immediately after an outage', async () => {
      b1.kill();
      await B.waitForFunction(() => window.__dv.link === 'offline', null, { timeout: 60000 });
      b2 = startBroker(P2); await sleep(800);
      await B.click('button:has-text("לנסות שוב")');
      await A.evaluate(() => window.__dv.net.wake());
      const t0 = Date.now();
      await linked(B); await linked(A);
      if (Date.now() - t0 > 12000) throw new Error('took ' + (Date.now() - t0) + 'ms');
      await move(A, B);
    });
    if (errs.length) { ok = false; console.log('script errors:\n' + errs.join('\n')); }
  } catch (e) { ok = false; console.log('CRASH', e.message); }
  await browser.close();
  b1.kill(); b2.kill();
  process.exit(ok ? 0 : 1);
})();

// Language: Hebrew on a Hebrew device, English on any other; the switch; no Hebrew left on English screens;
// a Hebrew phone and an English phone play together.
// Run: tests/with-servers.sh node tests/i18n.js [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8765/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const HEB = /[֐-׿]/;
const look = p => p.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir, title: document.title, text: document.body.innerText, wide: document.documentElement.scrollWidth > innerWidth + 1 }));

(async () => {
  const browser = await chromium.launch();
  const errs = [];
  const page = async (locale, url) => {
    const ctx = await browser.newContext({ locale, viewport: { width: 360, height: 760 } });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(locale + ': ' + e.message));
    await p.goto(url); await p.waitForSelector('#app *');
    return [p, ctx];
  };

  // ----- the device language decides -----
  for (const [locale, want] of [['he-IL', 'he'], ['en-US', 'en'], ['fr-FR', 'en'], ['ar', 'en'], ['iw', 'he']]) {
    const [p, ctx] = await page(locale, BASE + '?local=x');
    const l = await look(p);
    check(l.lang === want && l.dir === (want === 'he' ? 'rtl' : 'ltr'), `device language ${locale} → ${want} (${l.dir})`);
    await ctx.close();
  }

  // ----- English home: no Hebrew, the switch flips and is remembered -----
  {
    const [p, ctx] = await page('en-US', BASE + '?local=x');
    let l = await look(p);
    check(!HEB.test(l.text.replace('עברית', '')) && /Paper & Pencil/.test(l.text) && /Start a new page/.test(l.text), 'English home screen: English only (apart from the "עברית" switch)');
    check(l.title === 'Paper & Pencil', 'tab title in English');
    await p.click('.lang-switch button'); await p.waitForLoadState('load'); await p.waitForSelector('#app *');
    l = await look(p);
    check(l.lang === 'he' && l.dir === 'rtl' && /פותחים דף חדש/.test(l.text), 'the switch turns the site to Hebrew');
    await p.reload(); await p.waitForSelector('#app *');
    l = await look(p);
    check(l.lang === 'he', 'the choice is remembered after a reload');
    await p.click('.lang-switch button'); await p.waitForLoadState('load'); await p.waitForSelector('#app *');
    check((await look(p)).lang === 'en', 'and switches back');
    await ctx.close();
  }

  // ----- every English screen: no Hebrew left, nothing wider than the phone -----
  {
    const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 360, height: 760 } });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push('en demo: ' + e.message));
    const scenes = ['home', 'landing', 'guest-nohost', 'join', 'invite', 'menu', 'menu-mid', 'bull-secret', 'bull-play', 'bull-over', 'ships-place', 'ships-play', 'dots', 'five', 'five-many', 'five-over', 'decided', 'decided-menu', 'done-menu', 'lost'];
    const bad = [], wide = [];
    for (const sc of scenes) for (const me of [0, 1]) {
      await p.goto(`${BASE}?demo=${sc}&me=${me}&lang=en&help=1`); await sleep(250);
      const l = await look(p);
      // the demo players have English names; Hebrew may only appear in the language switch
      const heb = l.text.replace('עברית', '').split('\n').filter(x => HEB.test(x));
      if (heb.length) bad.push(`${sc}/${me}: ${heb[0].slice(0, 60)}`);
      if (l.wide) wide.push(`${sc}/${me}`);
    }
    check(!bad.length, `${scenes.length * 2} English screens without Hebrew` + (bad.length ? ': ' + bad.slice(0, 4).join(' | ') : ''));
    check(!wide.length, 'no English screen is wider than a 360px phone' + (wide.length ? ': ' + wide.join(', ') : ''));
    // hangman in English: the word keyboard starts in English
    await p.goto(`${BASE}?demo=hangman-word&me=0&lang=en`); await sleep(250);
    check(await p.evaluate(() => [...document.querySelectorAll('.keys .key')].some(k => k.textContent === 'A')), 'hangman: an English player gets the English keyboard first');
    await ctx.close();
  }

  // ----- a Hebrew phone hosts, an English phone joins, they play a game -----
  {
    const ctx = await browser.newContext({ locale: 'he-IL', viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => { window.__dvTest = true; });
    const A = await ctx.newPage(), B = await ctx.newPage();
    for (const [n, p] of [['he', A], ['en', B]]) p.on('pageerror', e => errs.push(n + ': ' + e.message));
    await A.goto(BASE + '?local=host&lang=he'); await A.fill('input.paper', 'אבא'); await A.click('text=פותחים דף חדש');
    const code = (await A.textContent('.code-big')).trim();
    await B.goto(BASE + `?local=guest&room=${code}&lang=en`); await B.fill('input.paper', 'Noa'); await B.click('text=Join ✏️');
    await A.waitForSelector('.game-row'); await B.waitForSelector('.game-row');
    check(/Series 1/.test(await B.textContent('.menu')) && /סדרה 1/.test(await A.textContent('.menu')), 'each phone shows the menu in its own language');
    await B.click('button[data-log^="next:"]');
    await A.waitForSelector('.help-card'); await B.waitForSelector('.help-card');
    check(/How to play Bulls & Cows/.test(await B.textContent('.help-card')) && /איך משחקים בול פגיעה/.test(await A.textContent('.help-card')), 'rules card in each phone\'s language');
    await A.click('.help-card >> text=הבנתי'); await B.click('.help-card >> text=Got it');
    await A.evaluate(() => window.__dv.act({ k: 'g', a: { k: 'secret', code: '1234' } }));
    await B.evaluate(() => window.__dv.act({ k: 'g', a: { k: 'secret', code: '5678' } }));
    await sleep(600);
    const s = await A.evaluate(() => window.__dv.state);
    const [P, f] = [[A, B], s.game.turn];
    await P[f].evaluate((c) => window.__dv.act({ k: 'g', a: { k: 'guess', code: c } }), f === 0 ? '5678' : '1234'); await sleep(500);
    if (!(await A.evaluate(() => window.__dv.state.game.over))) { await P[1 - f].evaluate(() => window.__dv.act({ k: 'g', a: { k: 'guess', code: '9012' } })); await sleep(500); }
    const rb = await B.textContent('.result'), ra = await A.textContent('.result');
    check(/(You won|A point for)/.test(rb) && /(ניצחת|נקודה ל)/.test(ra), 'the result is shown in each phone\'s language');
    check(/Next game: Hangman →/.test(rb), 'English arrows point forward (→)');
    await ctx.close();
  }

  // ----- the English address: English link preview, same game -----
  {
    const { execFileSync } = require('child_process');
    let upToDate = true;
    try { execFileSync('python3', [require('path').join(__dirname, '..', 'tools', 'make-en.py'), '--check']); } catch { upToDate = false; }
    check(upToDate, 'en/index.html matches index.html (run tools/make-en.py after changing index.html)');
    const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => { window.__dvTest = true; });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push('en/: ' + e.message));
    const r = await p.goto(BASE + 'en/?local=enaddr');
    const head = await r.text();
    check(/og-en\.png/.test(head) && /Paper &amp; Pencil – 5 games for two/.test(head), 'the English address has an English link preview');
    await p.fill('input.paper', 'Noa'); await p.click('text=Start a new page');
    await p.waitForSelector('.code-big');
    const wa = decodeURIComponent(await p.getAttribute('a[data-log="whatsapp"]', 'href'));
    check(/\/en\/\?room=/.test(wa) && /Noa invites you/.test(wa), 'an English phone invites with the English address');
    await ctx.close();
    const ctx2 = await browser.newContext({ locale: 'he-IL' });
    await ctx2.addInitScript(() => { window.__dvTest = true; });
    const q = await ctx2.newPage();
    await q.goto(BASE + '?local=headdr'); await q.fill('input.paper', 'אבא'); await q.click('text=פותחים דף חדש'); await q.waitForSelector('.code-big');
    const wa2 = decodeURIComponent(await q.getAttribute('a[data-log="whatsapp"]', 'href'));
    check(!/\/en\//.test(wa2) && /\?room=/.test(wa2), 'a Hebrew phone keeps the Hebrew address');
    await ctx2.close();
  }

  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'language: all checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

// The game as an app: manifest, offline start, "add to home screen" on Android / iPhone / inside Instagram,
// and the personal invite (who invites you, reassurance line).
// Run: tests/with-servers.sh node tests/pwa.js [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8765/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.40.92',
};

(async () => {
  const browser = await chromium.launch();
  const errs = [];

  // ----- manifest and icons -----
  {
    const ctx = await browser.newContext({ locale: 'he-IL' });
    const p = await ctx.newPage();
    const r = await p.goto(BASE + 'manifest.webmanifest');
    const m = JSON.parse(await r.text());
    check(m.name && m.start_url && m.display === 'standalone' && m.icons.some(i => i.sizes === '512x512') && m.icons.some(i => i.purpose === 'maskable'), 'manifest: name, start page, app mode, 512px and maskable icons');
    for (const i of m.icons) check((await p.goto(BASE + i.src)).ok(), `icon loads: ${i.src}`);
    check((await p.goto(BASE + 'icons/og.png')).ok(), 'link preview picture loads');
    await ctx.close();
  }

  // ----- offline start: after one visit, the app opens without internet -----
  {
    const ctx = await browser.newContext({ locale: 'he-IL' });
    await ctx.addInitScript(() => { window.__dvSW = true; });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push('sw: ' + e.message));
    await p.goto(BASE + '?local=sw');
    await p.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
    if (!(await p.evaluate(() => !!navigator.serviceWorker.controller))) { await p.reload(); await sleep(800); } // first visit: the worker takes over on the next load
    await p.reload(); await p.waitForSelector('input.paper'); await sleep(500);
    check(await p.evaluate(() => !!navigator.serviceWorker.controller), 'the offline starter is installed');
    await ctx.setOffline(true);
    await p.reload().catch(() => {});
    const ok = await p.waitForSelector('input.paper', { timeout: 8000 }).then(() => true).catch(() => false);
    check(ok, 'with no internet the app still opens');
    await ctx.setOffline(false);
    await ctx.close();
  }

  // ----- the install card after a finished game, per phone -----
  const gameDone = async ua => {
    const ctx = await browser.newContext({ locale: 'he-IL', userAgent: ua, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await ctx.addInitScript(() => { window.__dvTest = true; window.__dvNoHelp = true; });
    const A = await ctx.newPage(), B = await ctx.newPage();
    for (const p of [A, B]) p.on('pageerror', e => errs.push('install: ' + e.message));
    await A.goto(BASE + '?local=host'); await A.fill('input.paper', 'אבאלה'); await A.click('text=פותחים דף חדש');
    const code = (await A.textContent('.code-big')).trim();
    return { ctx, A, B, code };
  };
  {
    const { ctx, A, B, code } = await gameDone(UA.android);
    // the invite link carries the host's name; the join page greets with it and reassures
    const wa = decodeURIComponent(await A.getAttribute('a[data-log="whatsapp"]', 'href'));
    check(/from=אבאלה/.test(decodeURIComponent(wa)) && /אבאלה מזמין\/ה אותך/.test(wa), 'the invite says who invites, in the text and in the link');
    await B.goto(BASE + `?local=guest&room=${code}&from=${encodeURIComponent('אבאלה')}`);
    const join = await B.textContent('#app');
    check(/אבאלה מזמין\/ה אותך לשחק/.test(join), 'the join page opens with "<name> invites you to play"');
    check(/בחינם · בלי הרשמה · בלי הורדה · בלי פרסומות/.test(join), 'and says: free, no sign-up, no download, no ads');
    await B.goto(BASE + `?local=guest&room=${code}&from=${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
    check(!(await B.$('#app img')), 'a name in the link is shown as text only');
    await B.fill('input.paper', 'נועהלה'); await B.click('text=הצטרפות ✏️');
    await A.waitForSelector('.game-row'); await B.waitForSelector('.game-row');
    check(!(await A.$('.install-card')), 'no install card before the first game is played');
    // play the first game quickly
    await A.evaluate(() => window.__dv.act({ k: 'next' })); await sleep(400);
    await A.evaluate(() => window.__dv.act({ k: 'g', a: { k: 'secret', code: '1234' } }));
    await B.evaluate(() => window.__dv.act({ k: 'g', a: { k: 'secret', code: '5678' } })); await sleep(400);
    let s = await A.evaluate(() => window.__dv.state);
    const P = [A, B], f = s.game.turn;
    await P[f].evaluate(c => window.__dv.act({ k: 'g', a: { k: 'guess', code: c } }), f === 0 ? '5678' : '1234'); await sleep(400);
    if (!(await A.evaluate(() => window.__dv.state.game.over))) { await P[1 - f].evaluate(() => window.__dv.act({ k: 'g', a: { k: 'guess', code: '9012' } })); await sleep(400); }
    await A.evaluate(() => window.__dv.act({ k: 'menu' })); await sleep(400);
    check(!!(await A.$('.install-card')), 'after a finished game the menu offers "add to home screen"');
    // Android's own install dialog is opened by our button
    await A.evaluate(() => {
      const e = new Event('beforeinstallprompt');
      e.prompt = () => { window.__prompted = true; return Promise.resolve(); };
      e.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(e);
    });
    await A.click('.install-card button[data-log="install"]'); await sleep(300);
    check(await A.evaluate(() => !!window.__prompted), 'Android: the button opens the real install dialog');
    // "not now" puts it away for a week
    await A.click('.install-card button[data-log="install-later"]'); await sleep(200);
    check(!(await A.$('.install-card')), '"not now" puts the card away');
    await A.reload(); await A.waitForSelector('.game-row');
    check(!(await A.$('.install-card')), 'and it stays away after a reload');
    await ctx.close();
  }
  for (const [kind, ua, want] of [['iPhone', UA.ios, /שיתוף/], ['inside Instagram', UA.instagram, /פתיחה בדפדפן/]]) {
    const ctx = await browser.newContext({ locale: 'he-IL', userAgent: ua, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(kind + ': ' + e.message));
    await p.goto(BASE + '?local=x');
    await p.click('.install-link'); await sleep(300);
    const t = await p.textContent('.install-howto').catch(() => '');
    check(want.test(t), `${kind}: the button shows the right steps`);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ locale: 'he-IL', viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(BASE + '?local=x');
    check(!(await p.$('.install-link')), 'a computer is not asked to add to a home screen');
    await ctx.close();
  }

  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'app & invite: all checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

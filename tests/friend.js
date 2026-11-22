// Getting the friend in: (1) the friend arrives while the inviter is away and messages them back to the
// same page; (3) a visitor from an ad gets "invite a friend" as the first thing.
// Run: tests/with-servers.sh node tests/friend.js [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8765/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const stubShare = () => { window.__shared = []; navigator.share = d => { window.__shared.push(d); return Promise.resolve(); }; };

(async () => {
  const browser = await chromium.launch();
  const errs = [];

  // ----- (1) the friend comes later -----
  {
    const ctx = await browser.newContext({ locale: 'he-IL', viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => { window.__dvTest = true; window.__dvNoHelp = true; window.__dvAnalytics = { key: 'phc_test', host: 'https://ph.test' }; });
    const events = [];
    await ctx.route('https://ph.test/**', async r => { try { events.push(...JSON.parse(r.request().postData()).batch); } catch { /* */ } await r.fulfill({ status: 200, body: '{}' }); });
    const A = await ctx.newPage(); A.on('pageerror', e => errs.push('A: ' + e.message));
    await A.goto(BASE + '?local=host'); await A.fill('input.paper', 'אבאלה'); await A.click('text=פותחים דף חדש');
    const code = (await A.textContent('.code-big')).trim();
    check(/או סוגרים/.test(await A.textContent('.card')), 'the inviter is told it is fine to close and wait for a message');
    await A.close(); // the inviter goes away (the room stays saved on that phone)

    const B = await ctx.newPage(); B.on('pageerror', e => errs.push('B: ' + e.message));
    await B.addInitScript(stubShare);
    await B.goto(BASE + `?local=guest&room=${code}&from=${encodeURIComponent('אבאלה')}`);
    await B.fill('input.paper', 'נועהלה'); await B.click('text=הצטרפות ✏️');
    await B.waitForFunction(() => window.__dv.link === 'no-host', null, { timeout: 40000 });
    const note = await B.textContent('.conn');
    check(/אבאלה לא בדף כרגע/.test(note), 'the friend sees "<name> isn\'t on the page right now" (not "not answering")');
    check(!!(await B.$('button[data-log="nudge-host"]')), 'with a button to tell them');
    await B.evaluate(() => { navigator.share = d => { window.__shared.push(d); return Promise.resolve(); }; });
    await B.click('button[data-log="nudge-host"]'); await sleep(300);
    const shared = await B.evaluate(() => window.__shared);
    const text = shared.length ? shared[0].text : '';
    check(/נועהלה כאן/.test(text) && new RegExp(`room=${code}`).test(text) && /back=1/.test(text), 'the message says who is waiting and links back to the same page');
    // the inviter taps the link in the message: their phone reopens the room and the two connect by themselves
    const url = text.slice(text.indexOf('http'));
    const A2 = await ctx.newPage(); A2.on('pageerror', e => errs.push('A2: ' + e.message));
    await A2.goto(url);
    const met = await B.waitForFunction(() => window.__dv.link === 'linked' && window.__dv.state && window.__dv.state.players[1].token, null, { timeout: 40000 }).then(() => true).catch(() => false);
    check(met, 'the inviter opens the link and both phones connect, nothing else to do');
    check(await A2.evaluate(() => window.__dv.session && window.__dv.session.role === 'host'), 'the inviter is back as the host of the same page');
    await Promise.all([A2, B].map(p => p.evaluate(() => window.__dv.flushAnalytics()))); await sleep(400);
    check(events.some(e => e.event === 'host_nudged' && e.properties.method === 'native_share'), 'analytics: host_nudged');
    check(events.some(e => e.event === '$pageview' && e.properties.came_back_by_partner_message === true), 'analytics: the inviter came back by the message');
    check(!JSON.stringify(events).includes('אבאלה') && !JSON.stringify(events).includes('נועהלה'), 'no names in analytics');
    await ctx.close();
  }

  // ----- (3) from an ad: inviting comes first -----
  for (const [label, q, want] of [['paid ad', '?local=ad&utm_source=instagram&utm_medium=paid', true], ['TikTok click', '?local=ad2&ttclid=E.x', true], ['ordinary visit', '?local=ad3', false]]) {
    const ctx = await browser.newContext({ locale: 'he-IL', viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(stubShare);
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(label + ': ' + e.message));
    await p.goto(BASE + q); await p.waitForSelector('input.paper');
    const has = !!(await p.$('button[data-log="landing-invite"]'));
    check(has === want, `${label}: ${want ? '"invite a friend" is the main button' : 'the usual "start a new page"'}`);
    if (has) {
      await p.click('button[data-log="landing-invite"]');
      check(/קודם כותבים שם/.test(await p.textContent('.toast').catch(() => '')), 'without a name it asks for one first');
      await p.fill('input.paper', 'שירה'); await p.click('button[data-log="landing-invite"]');
      await p.waitForSelector('.code-big'); await sleep(300);
      const sh = await p.evaluate(() => window.__shared);
      check(sh.length === 1 && /room=/.test(sh[0].url) && /שירה מזמין\/ה אותך/.test(sh[0].text), 'one tap: the page opens and the invite goes out');
    }
    await ctx.close();
  }

  // ----- "our room": after a full series the pair keeps the link and can call each other back -----
  {
    const ctx = await browser.newContext({ locale: 'he-IL', viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(stubShare);
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push('our room: ' + e.message));
    await p.goto(BASE + '?demo=five-over&me=0'); await sleep(500);
    check(!!(await p.$('.result .our-room')), 'after the fifth game: "📌 your room" under the result');
    await p.click('.our-room button[data-log="again-tomorrow"]'); await sleep(300);
    const sh = await p.evaluate(() => window.__shared);
    check(sh.length === 1 && /נמשיך מחר/.test(sh[0].text) && /room=4821/.test(sh[0].text), '"again tomorrow?" sends the same link to the friend');
    await p.goto(BASE + '?demo=done-menu&me=1'); await sleep(500);
    check(!!(await p.$('.menu .our-room')), 'the table shows "your room" once the pair finished a series');
    await p.goto(BASE + '?demo=menu-mid&me=0'); await sleep(500);
    check(!(await p.$('.our-room')), 'not before a full series');
    await ctx.close();
  }
  {
    // the host comes back first, the guest is away: the host calls the guest back
    const ctx = await browser.newContext({ locale: 'he-IL', viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => { window.__dvTest = true; window.__dvNoHelp = true; window.__dvAnalytics = { key: 'phc_test', host: 'https://ph.test' }; });
    await ctx.addInitScript(stubShare);
    const events = [];
    await ctx.route('https://ph.test/**', async r => { try { events.push(...JSON.parse(r.request().postData()).batch); } catch { /* */ } await r.fulfill({ status: 200, body: '{}' }); });
    const A = await ctx.newPage(), B = await ctx.newPage();
    for (const [n, p] of [['A', A], ['B', B]]) p.on('pageerror', e => errs.push(n + ': ' + e.message));
    await A.goto(BASE + '?local=host'); await A.fill('input.paper', 'אבאלה'); await A.click('text=פותחים דף חדש');
    const code = (await A.textContent('.code-big')).trim();
    await B.goto(BASE + `?local=guest&room=${code}`); await B.fill('input.paper', 'נועהלה'); await B.click('text=הצטרפות ✏️');
    await A.waitForSelector('.game-row'); await B.waitForSelector('.game-row');
    await B.close(); await A.close();
    // the next day: the host opens the site; pretend the last visit was 20 hours ago
    const A2 = await ctx.newPage(); A2.on('pageerror', e => errs.push('A2: ' + e.message));
    await A2.goto(BASE + '?local=host');
    await A2.evaluate(() => { const k = 'dv:host:session'; const s = JSON.parse(localStorage.getItem(k)); s.lastActive = Date.now() - 20 * 3600000; localStorage.setItem(k, JSON.stringify(s)); });
    await A2.reload();
    await A2.waitForSelector('button[data-log="nudge-guest"]', { timeout: 30000 });
    check(/נועהלה/.test(await A2.textContent('button[data-log="nudge-guest"]')), 'the host who came back gets "📲 tell <friend> I\'m back"');
    await A2.click('button[data-log="nudge-guest"]'); await sleep(300);
    const text = (await A2.evaluate(() => window.__shared))[0].text;
    check(/חזרתי לחדר שלנו/.test(text) && new RegExp(`room=${code}`).test(text), 'the message links the friend back to the same room');
    const B2 = await ctx.newPage(); B2.on('pageerror', e => errs.push('B2: ' + e.message));
    await B2.goto(text.slice(text.indexOf('http')).replace('local=guest', 'local=guest'));
    const met = await A2.waitForFunction(() => window.__dv.link === 'linked', null, { timeout: 40000 }).then(() => true).catch(() => false);
    check(met && await B2.evaluate(() => window.__dv.session && window.__dv.session.role === 'guest'), 'the friend taps it and they are together again in the same room');
    await A2.evaluate(() => window.__dv.flushAnalytics()); await sleep(400);
    const back = events.find(e => e.event === 'returned_to_room');
    check(back && back.properties.role === 'host' && back.properties.hours_away >= 19, 'analytics: returned_to_room (role, hours away)');
    check(events.some(e => e.event === 'guest_nudged'), 'analytics: guest_nudged');
    await ctx.close();
  }

  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'friend: all checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

// Product analytics: two phones play through the real UI while every request to the analytics
// server is caught (nothing leaves the machine). Checks what is sent and – just as important – what is not.
// Run: tests/with-servers.sh node tests/analytics.js [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8765/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript(() => { window.__dvTest = true; window.__dvAnalytics = { key: 'phc_test', host: 'https://ph.test' }; });
  const events = [];
  let bad = 0;
  await ctx.route('https://ph.test/**', async route => {
    const req = route.request();
    try {
      const body = JSON.parse(req.postData());
      if (body.api_key !== 'phc_test' || !Array.isArray(body.batch)) bad++;
      events.push(...body.batch);
    } catch { bad++; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"Ok"}' });
  });
  const A = await ctx.newPage(), B = await ctx.newPage();
  const errs = [];
  for (const [n, p] of [['A', A], ['B', B]]) p.on('pageerror', e => errs.push(n + ': ' + e.message));
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const [a, b] = await Promise.all([A, B].map(p => p.evaluate(() => JSON.stringify(window.__dv.state))));
      if (a === b) return JSON.parse(a);
      await sleep(50);
    }
    throw new Error('phones did not agree');
  };
  const act = (p, a) => p.evaluate(a => window.__dv.act(a), a);
  const closeHelp = async () => { for (const p of [A, B]) if (await p.$('.help-card')) await p.click('.help-card >> text=הבנתי'); };

  // host opens a room, shares it, guest comes in through the invite link
  await A.goto(BASE + '?local=host&utm_source=test'); await A.fill('input.paper', 'אבאלה'); await A.click('text=פותחים דף חדש');
  const code = (await A.textContent('.code-big')).trim();
  await A.evaluate(() => { navigator.share = undefined; navigator.clipboard.writeText = () => Promise.resolve(); });
  await A.click('button[data-log="share"]');
  const wa = decodeURIComponent(await A.getAttribute('a[data-log="whatsapp"]', 'href'));
  check(wa.includes('src=test'), 'the invite link carries the campaign that brought the host (src=…)');
  await B.goto(BASE + `?local=guest&room=${code}&src=test`); await B.fill('input.paper', 'נועהלה'); await B.click('text=הצטרפות ✏️');
  await A.waitForSelector('.game-row'); await B.waitForSelector('.game-row');

  // game 1 (bull): host wins
  await A.click('button[data-log^="next:"]');
  await A.waitForSelector('.help-card'); await sleep(300); await closeHelp();
  await act(A, { k: 'g', a: { k: 'secret', code: '9157' } }); await act(B, { k: 'g', a: { k: 'secret', code: '8264' } });
  let s = await settle();
  const P = [A, B], f = s.game.turn;
  await act(P[f], { k: 'g', a: { k: 'guess', code: f === 0 ? '8264' : '9157' } }); await settle();
  s = await settle();
  if (!s.game.over) { await act(P[1 - f], { k: 'g', a: { k: 'guess', code: '1230' } }); s = await settle(); }
  check(s.game.over && s.game.over.winner === f, 'the game ended');
  // a note, the sound button, the "?" card, a rematch question
  await B.click('.chat-btn'); await B.click('.quick button >> nth=1'); await B.keyboard.press('Escape'); await B.click('.sheet-bg', { force: true }).catch(() => {});
  await A.click('.sound-btn');
  await A.click('button[data-log="next:hangman"]'); await sleep(300); await closeHelp();
  await A.click('.help-btn'); await A.click('.help-card >> text=הבנתי');
  await A.click('button[data-log="to-table"]'); await A.click('text=כן, לטבלה'); await settle();
  await B.click('button[data-log="leave"]'); await B.click('.modal >> text=יציאה');
  await sleep(300);
  await Promise.all([A, B].map(p => p.evaluate(() => window.__dv.flushAnalytics())));
  await sleep(500);

  const names = events.map(e => e.event);
  const by = (n, role) => events.filter(e => e.event === n && (!role || e.properties.role === role));
  console.log('   events:', [...new Set(names)].join(', '));
  check(bad === 0 && events.length > 15, `batches are well formed (${events.length} events)`);
  for (const n of ['$pageview', 'room_created', 'invite_shared', 'join_submitted', 'partner_joined', 'connected', 'screen_viewed', 'game_started', 'tutorial_viewed', 'tutorial_closed', 'game_completed', 'note_sent', 'sound_toggled', 'leave_game_prompt', 'game_abandoned', 'room_left']) {
    check(names.includes(n), `sends ${n}`);
  }
  const pv = by('$pageview');
  check(pv.some(e => e.properties.entry === 'direct' && e.properties.utm_source === 'test') && pv.some(e => e.properties.entry === 'invite_link'), 'page views tell a direct visit from an invite link, with utm');
  check(pv.some(e => e.properties.entry === 'invite_link' && e.properties.invited_from_source === 'test'), 'the invited friend is credited to the campaign');
  check(by('join_submitted')[0] && by('join_submitted')[0].properties.via === 'invite_link', 'the join knows it came from the link');
  check(by('invite_shared')[0] && by('invite_shared')[0].properties.method === 'copy_link', 'the invite method is recorded');
  const gc = by('game_completed');
  check(gc.length === 2 && gc.some(e => e.properties.role === 'host') && gc.some(e => e.properties.role === 'guest'), 'each phone reports the finished game once, tagged with its role');
  const h = by('game_completed', 'host')[0];
  check(h && h.properties.game === 'bull' && h.properties.outcome === (f === 0 ? 'host_won' : 'guest_won') && h.properties.moves >= 3 && h.properties.duration_s >= 0 && h.properties.game_index === 1, 'game_completed has game, outcome, moves, duration, position');
  check(gc.every(e => e.properties.game_uid === h.properties.game_uid), 'both copies share one game_uid (count unique)');
  const ga = by('game_abandoned', 'host')[0];
  check(ga && ga.properties.game === 'hangman' && ga.properties.left_by === 'host' && ga.properties.reason === 'to_menu', 'abandoning a game says which game, who left, and how');
  check(by('note_sent')[0] && by('note_sent')[0].properties.kind === 'quick', 'notes: only the kind of note');
  check(events.every(e => UUID7.test(e.uuid) && UUID7.test(e.properties.$session_id) && e.properties.distinct_id && e.properties.app_version), 'every event has uuid, session, anonymous id, version');
  check(new Set(events.map(e => e.uuid)).size === events.length, 'no event sent twice');
  // privacy: no names, no secrets, no room code
  const all = JSON.stringify(events);
  check(!/אבאלה|נועהלה/.test(all), 'player names are never sent');
  check(!/9157|8264/.test(all), 'secret codes are never sent');
  check(!all.includes(`room=${code}`) && !events.some(e => Object.values(e.properties).includes(code)), 'the room code is never sent');
  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

  // offline: events wait in storage and go out on the next visit
  const before = events.length;
  const offline = r => r.abort();
  await ctx.route('https://ph.test/**', offline);
  await A.evaluate(() => window.__dv.flushAnalytics());
  await A.click('.sound-btn').catch(() => {});
  await A.evaluate(() => window.__dv.flushAnalytics());
  await A.close({ runBeforeUnload: true }); await sleep(300);
  check(events.length === before, 'nothing got through while offline');
  await ctx.unroute('https://ph.test/**', offline);
  const A2 = await ctx.newPage();
  await A2.goto(BASE + '?local=host'); await A2.waitForSelector('.game-row'); await sleep(4500);
  check(events.length > before && events.slice(before).some(e => e.event === 'sound_toggled'), 'events made while offline are sent after the next load');

  // a TikTok ad click inside TikTok's own browser
  const ctx3 = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 musical_ly_2023405030 BytedanceWebview/d8a21c6' });
  await ctx3.addInitScript(() => { window.__dvAnalytics = { key: 'phc_test', host: 'https://ph.test' }; });
  const tt = [];
  await ctx3.route('https://ph.test/**', async r => { try { tt.push(...JSON.parse(r.request().postData()).batch); } catch { /* */ } await r.fulfill({ status: 200, body: '{}' }); });
  const T = await ctx3.newPage();
  await T.goto(BASE + '?local=host&utm_medium=paid&utm_campaign=launch&ttclid=E.C.P.abc123secret');
  await T.evaluate(() => window.__dv.flushAnalytics()); await sleep(400);
  const tpv = tt.find(e => e.event === '$pageview');
  check(tpv && tpv.properties.$browser === 'In-app (TikTok)' && tpv.properties.utm_source === 'tiktok' && tpv.properties.from_ad_click === true && tpv.properties.utm_campaign === 'launch', 'TikTok ad click: TikTok browser, source tiktok, campaign kept');
  check(!JSON.stringify(tt).includes('abc123secret'), 'the TikTok click id itself is not stored');
  await ctx3.close();

  // a guest phone with a copy of the game saved by an old version (before the series existed) must not crash
  {
    const c4 = await browser.newContext();
    await c4.addInitScript(() => { window.__dvAnalytics = { key: 'phc_test', host: 'https://ph.test' }; });
    const got = [];
    await c4.route('https://ph.test/**', async r => { try { got.push(...JSON.parse(r.request().postData()).batch); } catch { /* */ } await r.fulfill({ status: 200, body: '{}' }); });
    const O = await c4.newPage();
    const oe = []; O.on('pageerror', e => oe.push(e.message));
    await O.goto(BASE + '?local=old');
    await O.evaluate(() => {
      localStorage.setItem('dv:old:session', JSON.stringify({ role: 'guest', code: '4444', token: 'tok', name: 'x' }));
      localStorage.setItem('dv:old:gstate:4444', JSON.stringify({ rev: 7, players: [{ name: 'a', token: 'h' }, { name: 'x', token: 'tok' }], current: 'bull', game: { id: 'g1', phase: 'secret', secrets: [null, null] }, chat: [], scores: [1, 0] }));
    });
    await O.reload(); await sleep(1500);
    await O.evaluate(() => window.__dv.flushAnalytics()); await sleep(300);
    check(oe.length === 0, 'an old saved game does not crash the page' + (oe.length ? ': ' + oe[0] : ''));
    check(!!(await O.$('.conn')) && (await O.evaluate(() => window.__dv.state)) === null, 'it is dropped and the phone waits for a fresh copy from the host');
    check(got.some(e => e.event === 'stale_saved_game_dropped'), 'the drop is reported');
    await c4.close();
  }

  // demo / local runs without the test switch send nothing
  const ctx2 = await browser.newContext();
  let leaked = 0;
  await ctx2.route('**/*posthog*/**', r => { leaked++; r.abort(); });
  const C = await ctx2.newPage();
  await C.goto(BASE + '?local=host'); await C.fill('input.paper', 'x'); await C.click('text=פותחים דף חדש'); await sleep(1500);
  check(leaked === 0, 'local / test runs send nothing to the real analytics');

  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'analytics: all checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

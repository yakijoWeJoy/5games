// Visual / layout check of every screen on many screen sizes (Chromium engine, device emulation).
// For each scene x device it takes a screenshot and runs automatic checks:
//   - nothing sticks out of the page sideways (no horizontal scrolling)
//   - no button text is clipped, no tappable control is smaller than a finger
//   - marks drawn on the boards really have a size (are painted)
// Run: node tests/visual.js [baseUrl] [outDir]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:8765/';
const OUT = process.argv[3] || path.join(__dirname, '..', 'visual-out');

const DEVICES = [
  { name: 'phone-320 (old small android / iPhone SE1)', w: 320, h: 568, dpr: 2, mobile: true },
  { name: 'phone-360 (common android)', w: 360, h: 740, dpr: 3, mobile: true },
  { name: 'phone-375 (iPhone SE/mini)', w: 375, h: 667, dpr: 2, mobile: true },
  { name: 'phone-390 (iPhone 14)', w: 390, h: 844, dpr: 3, mobile: true },
  { name: 'phone-393x655 (iPhone + Brave, as seen in the logs)', w: 393, h: 655, dpr: 3, mobile: true },
  { name: 'phone-412 (Pixel)', w: 412, h: 915, dpr: 2.6, mobile: true },
  { name: 'phone-430 (iPhone Pro Max)', w: 430, h: 932, dpr: 3, mobile: true },
  { name: 'phone-landscape', w: 844, h: 390, dpr: 3, mobile: true },
  { name: 'tablet-768', w: 768, h: 1024, dpr: 2, mobile: true },
  { name: 'tablet-landscape', w: 1024, h: 768, dpr: 2, mobile: true },
  { name: 'laptop-1280x631 (as seen in the logs)', w: 1280, h: 631, dpr: 1, mobile: false },
  { name: 'laptop-1366', w: 1366, h: 768, dpr: 1, mobile: false },
  { name: 'desktop-1920', w: 1920, h: 1080, dpr: 1, mobile: false },
  { name: 'ultrawide-3440 (as seen in the logs)', w: 3440, h: 1440, dpr: 1, mobile: false },
];
const UI = process.env.UI_LANG === 'en' ? 'en' : 'he'; // UI_LANG=en checks the English screens
const SCENES = ['home', 'join', 'invite', 'menu', 'menu-mid', 'bull-secret', 'bull-play', 'bull-over', 'hangman-word', 'hangman-play',
  'ships-place', 'ships-play', 'dots', 'five', 'five-many', 'five-over', 'bull-play+help', 'hangman-play+help', 'ships-play+help', 'dots+help', 'five+help', 'decided', 'decided-menu', 'done-menu', 'lost'];

const CHECK = () => {
  const issues = [];
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) issues.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
  const inScroller = el => !!el.closest('.five-wrap, .quick, .msgs, .tech-log');
  for (const el of document.querySelectorAll('#app *, .fab')) {
    if (inScroller(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > vw + 1 || r.left < -1) issues.push(`sticks out: <${el.tagName.toLowerCase()} class="${el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className}"> ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  for (const el of document.querySelectorAll('button, a.btn, .cell.hot')) {
    if (inScroller(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    const label = (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 16);
    if (el.scrollWidth > el.clientWidth + 2 && el.tagName === 'BUTTON') issues.push(`text clipped in button "${label}"`);
    if ((r.width < 28 || r.height < 28) && !el.classList.contains('link-btn')) issues.push(`tiny tap target ${Math.round(r.width)}x${Math.round(r.height)} "${label}"`);
  }
  // the chat button must not cover a control that sits under it at the bottom of the screen
  const fab = document.querySelector('.fab');
  if (fab) {
    const f = fab.getBoundingClientRect();
    for (const el of document.querySelectorAll('#app button, #app .cell.hot')) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const atBottom = document.documentElement.scrollHeight - (r.bottom + window.scrollY) < 4;
      if (atBottom && r.left < f.right && r.right > f.left) issues.push('chat button can cover the last control');
    }
  }
  // drawn marks must have a size
  for (const el of document.querySelectorAll('.five-board svg path, .dots-svg g path, .board .cell svg *, .gallows path, .tally path')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) { issues.push('a drawn mark has no size'); break; }
  }
  // five in a row: every X / O must sit inside one square of the sheet, as it is really painted
  const fb = document.querySelector('.five-board');
  if (fb) {
    const b = fb.getBoundingClientRect(), cell = b.width / 21;
    let n = 0;
    for (const m of fb.querySelectorAll('svg > g, svg > path')) {
      if (m.getAttribute('opacity') === '0.8') continue; // the winning line
      const r = m.getBoundingClientRect();
      if (!r.width) continue;
      n++;
      const c0 = Math.floor((r.left + r.width / 2 - b.left) / cell), r0 = Math.floor((r.top + r.height / 2 - b.top) / cell);
      const inside = r.left >= b.left + c0 * cell - .5 && r.right <= b.left + (c0 + 1) * cell + .5 && r.top >= b.top + r0 * cell - .5 && r.bottom <= b.top + (r0 + 1) * cell + .5;
      if (!inside) issues.push(`five: a mark spills out of its square (row ${r0 + 1}, column ${c0 + 1})`);
    }
    const want = window.__dv.state.game.cells.filter(x => x >= 0).length;
    if (n !== want) issues.push(`five: ${n} marks painted for ${want} marks in the game`);
  }
  // whose turn: banner, page frame, dimmed board and header pencil must all tell the same story
  const st = window.__dv && window.__dv.state;
  if (st && st.game && !st.game.over && document.querySelector('.turn')) {
    const mineBanner = !!document.querySelector('.turn.mine'), waitBanner = !!document.querySelector('.turn.wait');
    if (mineBanner === waitBanner) issues.push('turn banner is neither "mine" nor "wait"');
    if (document.body.classList.contains('my-turn') !== mineBanner) issues.push('page frame does not match the banner');
    if (!!document.querySelector('.body-slot.wait') !== waitBanner) issues.push('dimmed board does not match the banner');
    if (mineBanner && !document.title.startsWith('✏️')) issues.push('tab title does not say it is my turn');
    if (!mineBanner && document.title.startsWith('✏️')) issues.push('tab title says my turn but it is not');
    const holder = document.querySelector('.ptag.holder');
    if (holder && holder.classList.contains('me') !== mineBanner) issues.push('header pencil is next to the wrong player');
    if (!document.querySelector('.help-btn')) issues.push('no "?" button');
    const tb = document.querySelector('.turn .turn-txt');
    if (tb && tb.scrollHeight > tb.clientHeight + 2) issues.push('turn text is cut off: "' + tb.textContent.slice(0, 30) + '"');
  }
  const hc = document.querySelector('.help-card');
  if (hc) {
    const r = hc.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight + 1) issues.push(`"how to play" card does not fit on the screen (${Math.round(r.top)}..${Math.round(r.bottom)} of ${window.innerHeight})`);
    if (hc.querySelectorAll('li').length < 3) issues.push('"how to play" card has no text');
  }
  return [...new Set(issues)].slice(0, 8);
};

const ONLY = process.env.SCENES ? process.env.SCENES.split(',') : null; // e.g. SCENES=five,five-many

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  let bad = 0, total = 0;
  for (const d of DEVICES) {
    const ctx = await browser.newContext({ locale: UI === 'en' ? 'en-US' : 'he-IL', viewport: { width: d.w, height: d.h }, deviceScaleFactor: 1, isMobile: d.mobile, hasTouch: d.mobile });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    const tag = d.name.split(' ')[0];
    for (const sc of SCENES) {
      if (ONLY && !ONLY.includes(sc) && !ONLY.includes(sc.split('+')[0])) continue;
      for (const me of sc === 'home' || sc === 'join' || sc === 'invite' ? [0] : [0, 1]) {
        total++;
        const [scene, extra] = sc.split('+');
        await page.goto(`${BASE}?demo=${scene}&me=${me}&lang=${UI}${extra ? '&' + extra + '=1' : ''}`);
        await page.waitForTimeout(350);
        const issues = await page.evaluate(CHECK);
        if (errs.length) issues.push('script error: ' + errs.splice(0).join(' | '));
        await page.screenshot({ path: path.join(OUT, `${tag}__${sc.replace('+', '-')}__p${me}.png`), fullPage: true });
        if (issues.length) { bad++; console.log(`✗ ${d.name} / ${sc} (player ${me}):\n    ` + issues.join('\n    ')); }
      }
    }
    await ctx.close();
  }
  console.log(`\n${total - bad}/${total} screens clean`);
  await browser.close();
  process.exit(bad ? 1 : 0);
})();

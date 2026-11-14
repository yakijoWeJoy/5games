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
  { name: 'phone-412 (Pixel)', w: 412, h: 915, dpr: 2.6, mobile: true },
  { name: 'phone-430 (iPhone Pro Max)', w: 430, h: 932, dpr: 3, mobile: true },
  { name: 'phone-landscape', w: 844, h: 390, dpr: 3, mobile: true },
  { name: 'tablet-768', w: 768, h: 1024, dpr: 2, mobile: true },
  { name: 'tablet-landscape', w: 1024, h: 768, dpr: 2, mobile: true },
  { name: 'laptop-1366', w: 1366, h: 768, dpr: 1, mobile: false },
  { name: 'desktop-1920', w: 1920, h: 1080, dpr: 1, mobile: false },
];
const SCENES = ['home', 'join', 'invite', 'menu', 'menu-mid', 'bull-secret', 'bull-play', 'bull-over', 'hangman-word', 'hangman-play',
  'ships-place', 'ships-play', 'dots', 'five', 'five-over', 'decided', 'decided-menu', 'done-menu', 'lost'];

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
  return [...new Set(issues)].slice(0, 8);
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  let bad = 0, total = 0;
  for (const d of DEVICES) {
    const ctx = await browser.newContext({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: 1, isMobile: d.mobile, hasTouch: d.mobile });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    const tag = d.name.split(' ')[0];
    for (const sc of SCENES) {
      for (const me of sc === 'home' || sc === 'join' || sc === 'invite' ? [0] : [0, 1]) {
        total++;
        await page.goto(`${BASE}?demo=${sc}&me=${me}`);
        await page.waitForTimeout(350);
        const issues = await page.evaluate(CHECK);
        if (errs.length) issues.push('script error: ' + errs.splice(0).join(' | '));
        await page.screenshot({ path: path.join(OUT, `${tag}__${sc}__p${me}.png`), fullPage: true });
        if (issues.length) { bad++; console.log(`✗ ${d.name} / ${sc} (player ${me}):\n    ` + issues.join('\n    ')); }
      }
    }
    await ctx.close();
  }
  console.log(`\n${total - bad}/${total} screens clean`);
  await browser.close();
  process.exit(bad ? 1 : 0);
})();

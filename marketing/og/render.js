// Renders the link preview picture to icons/og.png.  Run from the repo root:  python3 -m http.server 8765 &  node marketing/og/render.js
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.goto('http://localhost:8765/marketing/og/og.html');
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(__dirname, '..', '..', 'icons', 'og.png') });
  await b.close();
  console.log('icons/og.png rendered');
})();

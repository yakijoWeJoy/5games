// Renders the link preview pictures: icons/og.png (Hebrew) and icons/og-en.png (English).  Run from the repo root:  python3 -m http.server 8765 &  node marketing/og/render.js
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  for (const [lang, file] of [['he', 'og.png'], ['en', 'og-en.png']]) {
    await p.goto('http://localhost:8765/marketing/og/og.html?lang=' + lang);
    await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(__dirname, '..', '..', 'icons', file) });
  }
  await b.close();
  console.log('icons/og.png and icons/og-en.png rendered');
})();

// Renders the icon in every size the site and Instagram need.
// Run from the repo root:  python3 -m http.server 8765 &  node marketing/icon/render.js
const { chromium } = require('playwright');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const URL = 'http://localhost:8765/marketing/icon/icon.html';

(async () => {
  const b = await chromium.launch();
  const out = [
    // [file, size, round?]  – site icons live in /icons, the Instagram picture next to this script
    ['icons/icon-512.png', 512], ['icons/icon-192.png', 192], ['icons/apple-touch-icon.png', 180, 'full'], ['icons/favicon-32.png', 32],
    ['icons/icon-maskable-512.png', 512, 'maskable'],
    ['marketing/icon/icon-1024.png', 1024], ['marketing/icon/instagram-profile-1080.png', 1080, 'round'],
  ];
  for (const [file, size, mode] of out) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.goto(URL + (mode ? '?round=1' : ''));
    await p.evaluate(() => document.fonts.ready);
    await p.addStyleTag({ content: `svg { width: ${size}px !important; height: ${size}px !important; }` });
    await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(ROOT, file), omitBackground: !mode });
    await p.close();
  }
  await b.close();
  console.log('icons rendered');
})();

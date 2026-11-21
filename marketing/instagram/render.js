// Renders the Instagram ad: story.png (1080x1920), feed.png (1080x1350), story.mp4 (8s, 30fps).
// Run from the repo root:  python3 -m http.server 8765 &  node marketing/instagram/render.js
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname);
const URL = 'http://localhost:8765/marketing/instagram/ad.html';
const VIDEO = !process.argv.includes('--no-video');

(async () => {
  const b = await chromium.launch();
  for (const [fmt, h] of [['story', 1920], ['feed', 1350]]) {
    const p = await b.newPage({ viewport: { width: 1080, height: h } });
    await p.goto(`${URL}?fmt=${fmt}`);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(500);
    // jump every animation to its end state for the still image
    await p.evaluate(() => document.getAnimations().forEach(a => { if (a.effect.getTiming().iterations === Infinity) a.cancel(); else a.finish(); }));
    await p.screenshot({ path: path.join(DIR, `${fmt}.png`) });
    if (fmt === 'story' && VIDEO) {
      const frames = path.join(DIR, '.frames');
      fs.rmSync(frames, { recursive: true, force: true }); fs.mkdirSync(frames);
      await p.reload(); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400);
      await p.evaluate(() => document.getAnimations().forEach(a => a.pause()));
      const FPS = 30, SECONDS = 8;
      for (let i = 0; i < FPS * SECONDS; i++) {
        await p.evaluate(t => document.getAnimations().forEach(a => { a.currentTime = t; }), (i * 1000) / FPS);
        await p.screenshot({ path: path.join(frames, `f${String(i).padStart(4, '0')}.png`) });
      }
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', path.join(DIR, 'story.mp4')]);
      fs.rmSync(frames, { recursive: true, force: true });
    }
    await p.close();
  }
  await b.close();
  console.log('rendered:', fs.readdirSync(DIR).filter(f => /\.(png|mp4)$/.test(f)).join(', '));
})();

// Tap accuracy on short screens (the sizes seen on real devices): after scrolling down to the board,
// a tap must (1) not make the page jump and (2) draw its mark exactly where the finger / mouse is.
// Run: node tests/interact.js [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8765/';
const SIZES = [
  { name: 'iPhone+Brave 393x655', w: 393, h: 655, touch: true },
  { name: 'small phone 320x568', w: 320, h: 568, touch: true },
  { name: 'short laptop 1280x631', w: 1280, h: 631, touch: false },
  { name: 'ultrawide 3440x1440', w: 3440, h: 1440, touch: false },
  { name: 'phone landscape 844x390', w: 844, h: 390, touch: true },
];
let failed = 0;
const check = (ok, label, detail) => { if (!ok) { failed++; console.log(`  ✗ ${label}: ${detail}`); } };

(async () => {
  const browser = await chromium.launch();
  for (const d of SIZES) {
    const ctx = await browser.newContext({ locale: 'he-IL', viewport: { width: d.w, height: d.h }, isMobile: d.touch, hasTouch: d.touch });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    const hit = async (x, y) => (d.touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
    const before = failed;

    // ---------- five in a row ----------
    for (const me of [0, 1]) {
      await page.goto(`${BASE}?demo=five&me=${me}`);
      await page.waitForTimeout(300);
      if (!(await page.$('.turn.mine'))) continue;
      for (const [R, C, scrollBoard] of [[12, 9, false], [10, 13, false], [3, 17, true], [19, 2, true]]) {
        // scroll the page to the bottom and (optionally) the sheet to the wanted corner, like a player would
        await page.evaluate(([r, c, sb]) => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          if (sb) { const w = document.querySelector('.five-wrap'), cell = document.querySelector('.five-board').clientWidth / 21; w.scrollLeft = (c + .5) * cell - w.clientWidth / 2; w.scrollTop = (r + .5) * cell - w.clientHeight / 2; }
        }, [R, C, scrollBoard]);
        await page.waitForTimeout(120);
        const pos = await page.evaluate(([r, c]) => {
          const b = document.querySelector('.five-board').getBoundingClientRect(), w = document.querySelector('.five-wrap').getBoundingClientRect();
          const cell = b.width / 21, x = b.left + (c + .5) * cell, y = b.top + (r + .5) * cell;
          return { x, y, vis: x > w.left + 4 && x < w.right - 4 && y > w.top + 4 && y < w.bottom - 4 && y < window.innerHeight - 4 && y > 4, sy: window.scrollY };
        }, [R, C]);
        if (!pos.vis) continue; // that cell is not on screen for this size
        await hit(pos.x, pos.y);
        await page.waitForTimeout(150);
        const after = await page.evaluate(() => {
          const s = document.querySelector('.five-sel'); if (!s) return null;
          const q = s.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2, sy: window.scrollY };
        });
        check(!!after, `five (${R},${C})`, 'no selection mark appeared');
        if (after) {
          check(Math.abs(after.x - pos.x) < 2 && Math.abs(after.y - pos.y) < 2, `five (${R},${C})`, `mark is ${Math.round(after.x - pos.x)},${Math.round(after.y - pos.y)}px away from the tap`);
          check(Math.abs(after.sy - pos.sy) < 2, `five (${R},${C})`, `page jumped by ${Math.round(after.sy - pos.sy)}px`);
          // second tap on the same spot places the mark there
          const n0 = await page.evaluate(() => window.__dv.state.game.cells.filter(x => x >= 0).length);
          await hit(pos.x, pos.y);
          await page.waitForTimeout(150);
          const placed = await page.evaluate(([r, c]) => ({ v: window.__dv.state.game.cells[r * 21 + c], n: window.__dv.state.game.cells.filter(x => x >= 0).length, sy: window.scrollY }), [R, C]);
          check(placed.v === me && placed.n === n0 + 1, `five (${R},${C})`, 'second tap did not place the mark in that cell');
          check(Math.abs(placed.sy - pos.sy) < 2, `five (${R},${C}) confirm`, `page jumped by ${Math.round(placed.sy - pos.sy)}px`);
        }
        break; // one placement per load (then it is the other player's turn)
      }
    }

    // ---------- battleships: aim, then fire ----------
    for (const me of [0, 1]) {
      await page.goto(`${BASE}?demo=ships-play&me=${me}`);
      await page.waitForTimeout(300);
      if (!(await page.$('.turn.mine'))) continue;
      await page.evaluate(() => { const c = [...document.querySelectorAll('.board:not(.small) .cell.hot')].pop(); c.scrollIntoView({ block: 'center' }); });
      await page.waitForTimeout(120);
      const pos = await page.evaluate(() => { const c = [...document.querySelectorAll('.board:not(.small) .cell.hot')].pop(); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, sy: window.scrollY, label: c.getAttribute('aria-label') }; });
      await hit(pos.x, pos.y);
      await page.waitForTimeout(150);
      let after = await page.evaluate(() => { const c = document.querySelector('.board:not(.small) .cell.sel'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, sy: window.scrollY, label: c.getAttribute('aria-label'), mark: !!c.querySelector('svg circle') }; });
      check(!!after && after.mark, 'ships aim', 'no aim mark appeared');
      if (after) {
        check(after.label === pos.label && Math.abs(after.x - pos.x) < 2 && Math.abs(after.y - pos.y) < 2, 'ships aim', `aim is on ${after.label} (${Math.round(after.x - pos.x)},${Math.round(after.y - pos.y)}px away), tapped ${pos.label}`);
        check(Math.abs(after.sy - pos.sy) < 2, 'ships aim', `page jumped by ${Math.round(after.sy - pos.sy)}px`);
        await hit(pos.x, pos.y);
        await page.waitForTimeout(150);
        const shot = await page.evaluate(lbl => { const c = document.querySelector(`.board:not(.small) .cell[aria-label="${lbl}"]`); const r = c.getBoundingClientRect(); const m = c.querySelector('svg circle, svg path'); const q = m ? m.getBoundingClientRect() : null; return { y: r.top + r.height / 2, sy: window.scrollY, mark: !!q && q.width > 2, shots: window.__dv.state.game.shots.flat().length }; }, pos.label);
        check(shot.mark, 'ships fire', 'no mark in the cell after firing');
        check(Math.abs(shot.sy - pos.sy) < 2 && Math.abs(shot.y - pos.y) < 2, 'ships fire', `page jumped by ${Math.round(shot.sy - pos.sy)}px / cell moved ${Math.round(shot.y - pos.y)}px`);
      }
    }

    // ---------- dots: the line appears between the two dots that were tapped ----------
    for (const me of [0, 1]) {
      await page.goto(`${BASE}?demo=dots&me=${me}`);
      await page.waitForTimeout(300);
      if (!(await page.$('.turn.mine'))) continue;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(120);
      const pos = await page.evaluate(() => {
        const polys = [...document.querySelectorAll('.dots-svg polygon')].filter(p => { const r = p.getBoundingClientRect(); return r.top > 30 && r.bottom < window.innerHeight - 10; });
        const p = polys[Math.floor(polys.length / 2)]; const r = p.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, sy: window.scrollY, n: document.querySelectorAll('.dots-svg > g:first-of-type path, .dots-svg g[stroke-width="4"] path').length, lines: window.__dv.state.game.h.flat().concat(window.__dv.state.game.v.flat()).filter(x => x >= 0).length };
      });
      await hit(pos.x, pos.y);
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => {
        const g = window.__dv.state.game; const last = g.last;
        const paths = [...document.querySelectorAll('.dots-svg g[stroke-width="4"] path')];
        // the newest stroke is the one whose centre is closest to the highlighted (last) line
        const hl = document.querySelector('.dots-svg > path'); const h = hl ? hl.getBoundingClientRect() : null;
        return { sy: window.scrollY, lines: g.h.flat().concat(g.v.flat()).filter(x => x >= 0).length, hx: h ? h.left + h.width / 2 : null, hy: h ? h.top + h.height / 2 : null, drawn: paths.length, last };
      });
      check(after.lines === pos.lines + 1, 'dots', 'tap did not draw a line');
      check(after.drawn === after.lines, 'dots', `${after.drawn} strokes painted for ${after.lines} lines`);
      check(after.hx != null && Math.abs(after.hx - pos.x) < 3 && Math.abs(after.hy - pos.y) < 3, 'dots', `new line is ${Math.round(after.hx - pos.x)},${Math.round(after.hy - pos.y)}px away from the tap`);
      check(Math.abs(after.sy - pos.sy) < 2, 'dots', `page jumped by ${Math.round(after.sy - pos.sy)}px`);
    }

    // ---------- keyboards: typing must not make the page jump ----------
    for (const [scene, key] of [['bull-secret', '7'], ['hangman-word', 'ש']]) {
      await page.goto(`${BASE}?demo=${scene}&me=0`);
      await page.waitForTimeout(250);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(100);
      const k = await page.$(`.key:text-is("${key}")`);
      const b0 = await k.boundingBox(); const sy0 = await page.evaluate(() => window.scrollY);
      await hit(b0.x + b0.width / 2, b0.y + b0.height / 2);
      await page.waitForTimeout(150);
      const b1 = await (await page.$(`.key:text-is("${key}")`)).boundingBox(); const sy1 = await page.evaluate(() => window.scrollY);
      check(Math.abs(sy1 - sy0) < 2 && Math.abs(b1.y - b0.y) < 2, `${scene} keyboard`, `page jumped by ${Math.round(sy1 - sy0)}px, key moved ${Math.round(b1.y - b0.y)}px`);
    }

    if (errs.length) { failed++; console.log('  ✗ script errors: ' + errs.join(' | ')); }
    console.log(`${failed === before ? 'PASS' : 'FAIL'}  ${d.name}`);
    await ctx.close();
  }
  await browser.close();
  console.log(failed ? `\n${failed} problems` : '\nall taps land where they should');
  process.exit(failed ? 1 : 0);
})();

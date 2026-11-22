import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { copyTemplate, tmpdir } from '../scripts/lib/testing.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

test('双对数散点：横竖屏按数量级定位、顺序显现，重复 seek 一致', { timeout: 120000 }, async () => {
  const dir = tmpdir();
  const html = path.join(dir, 'chart.html');
  copyTemplate('log-scatter.html', html);
  // 用户编辑配置后，新的数值也必须按对数坐标定位。
  const src = fs.readFileSync(html, 'utf8');
  assert.ok(src.includes('x: 57.9'));
  fs.writeFileSync(html, src.replace('x: 57.9', 'x: 50'));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [width, height] of [[1280, 720], [1080, 1920]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => { window.__seekRender = true; });
      await page.goto(pathToFileURL(html).href);
      const result = await page.evaluate(() => {
        const counts = [];
        const oldArc = CanvasRenderingContext2D.prototype.arc;
        CanvasRenderingContext2D.prototype.arc = function (...args) { counts[counts.length - 1]++; return oldArc.apply(this, args); };
        const hashes = [];
        for (const t of [0, 2.1, 6, 7.5, 2.1]) {
          counts.push(0); window.__seek(t); hashes.push(document.querySelector('canvas').toDataURL());
        }
        CanvasRenderingContext2D.prototype.arc = oldArc;
        const moves = [], oldMove = CanvasRenderingContext2D.prototype.moveTo, oldLine = CanvasRenderingContext2D.prototype.lineTo;
        let origin;
        CanvasRenderingContext2D.prototype.moveTo = function (x, y) { origin = [x, y]; return oldMove.call(this, x, y); };
        CanvasRenderingContext2D.prototype.lineTo = function (x, y) {
          if (Math.abs(this.lineWidth - 6 * S) < 1e-6) moves.push({ origin, end: [x, y] });
          return oldLine.call(this, x, y);
        };
        window.__seek(3);
        CanvasRenderingContext2D.prototype.moveTo = oldMove;
        CanvasRenderingContext2D.prototype.lineTo = oldLine;
        return {
          guides: moves, target: [px(CFG.points[3].x), py(CFG.points[3].y)],
          ready: window.__ready, canvas: [cv.width, cv.height], counts, firstX: CFG.points[0].x, firstPosition: px(CFG.points[0].x), midpoint: (px(10) + px(100)) / 2,
          repeat: hashes[1] === hashes[4],
          xSteps: [px(100) - px(10), px(1000) - px(100)],
          ySteps: [py(10) - py(100), py(100) - py(1000)],
        };
      });
      assert.deepEqual(errors, []);
      assert.equal(result.ready, true);
      assert.equal(result.firstX, 50);
      assert.ok(result.firstPosition > result.midpoint, '50 在对数刻度上应位于 10 与 100 的中点右侧');
      assert.deepEqual(result.canvas, [width, height]);
      assert.deepEqual(result.counts, [0, 3, 7, 8, 3]);
      assert.equal(result.guides.length, 2, '当前点应有两条读数辅助线');
      assert.deepEqual(result.guides[0].origin, result.target);
      assert.deepEqual(result.guides[1].origin, result.target);
      assert.equal(result.guides[0].end[1], result.target[1], '横向辅助线只指向纵轴');
      assert.ok(result.guides[0].end[0] < result.target[0]);
      assert.equal(result.guides[1].end[0], result.target[0], '纵向辅助线只指向横轴');
      assert.ok(result.guides[1].end[1] > result.target[1]);
      assert.equal(result.repeat, true, 'seek 回同一时刻画面必须相同');
      assert.ok(Math.abs(result.xSteps[0] - result.xSteps[1]) < 1e-6);
      assert.ok(Math.abs(result.ySteps[0] - result.ySteps[1]) < 1e-6);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('双对数散点：非正数数据报错', { timeout: 120000 }, async () => {
  const dir = tmpdir();
  const html = path.join(dir, 'chart.html');
  copyTemplate('log-scatter.html', html);
  const src = fs.readFileSync(html, 'utf8');
  assert.ok(src.includes('x: 57.9'));
  fs.writeFileSync(html, src.replace('x: 57.9', 'x: 0'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { window.__seekRender = true; });
    const error = page.waitForEvent('pageerror');
    await page.goto(pathToFileURL(html).href);
    assert.match((await error).message, /大于零/);
    assert.equal(await page.evaluate(() => window.__ready), undefined);
  } finally { await browser.close(); }
});

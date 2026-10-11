/**
 * 冒烟测试：渲染全量前先跑这个。
 * 验证三件事 —— __seek 契约就绪、无控制台报错、关键帧画面正确。
 *
 * 用法（必须 CJS，ESM 不认 NODE_PATH）：
 *   NODE_PATH="<node工作区>/node_modules" node smoke.cjs [animation.html]
 *
 * 更省事：直接跑同目录的 smoke.sh，它会自动读取 ~/.workbuddy/.html2video-env。
 * 可选环境变量：SMOKE_W / SMOKE_H（视口尺寸）、SMOKE_T（逗号分隔的时间点）。
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const HTML = process.argv[2] || 'animation.html';
const W = parseInt(process.env.SMOKE_W || '1920', 10);
const H = parseInt(process.env.SMOKE_H || '1080', 10);
const STAMPS = (process.env.SMOKE_T || '0,1.2,4.0,8.0,11.5')
  .split(',').map(s => parseFloat(s.trim()));

(async () => {
  const abs = path.resolve(HTML);
  const outDir = path.join(path.dirname(abs), 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  // 与 render-video-seek.js 注入的信号保持一致
  await ctx.addInitScript(() => { window.__recording = true; window.__seekRender = true; });
  const page = await ctx.newPage();

  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto('file://' + abs, { waitUntil: 'load' });

  try {
    await page.waitForFunction(
      () => window.__ready === true && typeof window.__seek === 'function',
      { timeout: 10000 },
    );
    console.log('[OK] __seek 契约就绪');
  } catch (e) {
    console.error('[FAIL] 动画没有暴露 window.__seek / __ready。');
    console.error('       检查 HTML 末尾的「渲染契约」段落是否被改动。');
    await browser.close();
    process.exit(1);
  }

  for (const t of STAMPS) {
    await page.evaluate(tt => window.__seek(tt), t);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const name = 'smoke-t' + String(t).replace('.', '_') + '.png';
    await page.screenshot({ path: path.join(outDir, name), clip: { x: 0, y: 0, width: W, height: H } });
    console.log('  截帧 t=' + t + ' -> out/' + name);
  }

  await browser.close();

  if (errs.length) {
    console.error('[FAIL] 页面错误：\n  ' + errs.join('\n  '));
    process.exit(1);
  }
  console.log('[OK] 无控制台错误。看图确认画面后，再跑全量渲染。');
})();

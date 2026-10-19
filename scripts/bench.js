#!/usr/bin/env node
/**
 * 性能基线 bench —— 把「渲染有多慢」变成一个能写进文档的数字。
 *
 * 为什么需要它：同一个动画在不同机器上差 3–5 倍，文档里写「约 6~7 分钟」是拍出来的。
 * 有了这条命令，任何人都能在自己机器上量一次，拿自己机器的数字估算长片要渲多久。
 *
 * 用法：
 *   node scripts/bench.js                        # 默认：两个模板 × 两档分辨率 × auto/4 并发
 *   node scripts/bench.js --frames=60            # 每个配置渲 60 帧（默认 30）
 *   node scripts/bench.js --html=assets/templates/explainer.html
 *   node scripts/bench.js --sizes=1920x1080,1080x1920 --concurrency=auto,4
 *
 * 产物：bench/bench.md（表）+ bench/bench.json（原始数字）
 * 说明：渲在临时目录里，不会在项目目录里留 .mp4。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RENDER = path.join(ROOT, 'scripts', 'render-video-seek.js');

function arg(name, def) {
  const p = process.argv.find(a => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : def;
}

const FRAMES = Math.max(5, parseInt(arg('frames', '30'), 10) || 30);
const HTMLS = String(arg('html', 'assets/templates/title-card.html,assets/templates/explainer.html'))
  .split(',').map(s => s.trim()).filter(Boolean);
const SIZES = String(arg('sizes', '1920x1080,1280x720')).split(',').map(s => s.trim()).filter(Boolean)
  .map(s => { const [w, h] = s.split(/[x×]/).map(v => parseInt(v, 10)); return { w, h, label: s }; });
const CONCS = String(arg('concurrency', 'auto,4')).split(',').map(s => s.trim()).filter(Boolean);
const OUT_DIR = path.resolve(arg('out', path.join(ROOT, 'bench')));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2v-bench-'));
const benchDir = path.join(tmp, 'bench');
fs.mkdirSync(benchDir, { recursive: true });

/* 模板依赖 ../lib/*.js 和 ./themes.js —— 复制到临时目录时要把这两样一起带上，
   否则页面加载不到库文件，量出来的时间是一个白屏的时间，没有意义。 */
const LIB = path.join(ROOT, 'assets', 'lib');
if (fs.existsSync(LIB)) fs.cpSync(LIB, path.join(tmp, 'lib'), { recursive: true });

const rows = [];
console.log(`▸ bench: ${HTMLS.length} 个页面 × ${SIZES.length} 档分辨率 × ${CONCS.length} 种并发 · 每档 ${FRAMES} 帧`);
console.log(`  临时目录：${tmp}`);

for (const html of HTMLS) {
  const src = path.resolve(ROOT, html);
  if (!fs.existsSync(src)) { console.warn(`⚠ 跳过（文件不存在）：${html}`); continue; }
  const name = path.basename(html, '.html');
  const dst = path.join(benchDir, name + '.html');
  fs.copyFileSync(src, dst);
  const themesSrc = path.join(path.dirname(src), 'themes.js');
  if (fs.existsSync(themesSrc)) fs.copyFileSync(themesSrc, path.join(benchDir, 'themes.js'));

  for (const size of SIZES) {
    for (const conc of CONCS) {
      const secs = FRAMES / 30;
      const args = [
        dst, '--from=0', `--to=${secs}`, '--fps=30',
        `--width=${size.w}`, `--height=${size.h}`, `--concurrency=${conc}`, '--allow-errors',
      ];
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [RENDER, ...args], {
        encoding: 'utf8',
        env: process.env,
        timeout: 900000,
      });
      const ms = Date.now() - t0;
      const ok = r.status === 0;
      const out = (r.stdout || '') + (r.stderr || '');
      const frames = (out.match(/Captured (\d+)\//) || [])[1];
      const perFrame = ok && frames ? (ms / 1000) / Number(frames) : null;
      rows.push({
        html: name, size: size.label, concurrency: conc, ok,
        frames: frames ? Number(frames) : null,
        wall_s: +(ms / 1000).toFixed(1),
        s_per_frame: perFrame ? +perFrame.toFixed(3) : null,
        est_10s_60fps_s: perFrame ? Math.round(perFrame * 600) : null,
      });
      console.log(`  ${ok ? '✓' : '✗'} ${name} ${size.label} ×${conc} → ${(ms / 1000).toFixed(1)}s`
        + (perFrame ? `（${perFrame.toFixed(3)} s/帧；10s@60fps 约 ${Math.round(perFrame * 600)}s）` : ''));
      if (!ok) console.log('    ' + out.split('\n').filter(Boolean).slice(-3).join('\n    '));
    }
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const env = {
  node: process.version,
  cpu: (os.cpus()[0] && os.cpus()[0].model) || 'unknown',
  cores: os.cpus().length,
  mem_gb: +(os.totalmem() / 1073741824).toFixed(1),
  date: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(path.join(OUT_DIR, 'bench.json'), JSON.stringify({ env, rows }, null, 2), 'utf8');

const md = [];
md.push('# 渲染性能基线');
md.push('');
md.push(`机器：${env.cpu} · ${env.cores} 核 · ${env.mem_gb} GB · Node ${env.node} · ${env.date}`);
md.push('');
md.push('| 页面 | 分辨率 | 并发 | 帧数 | 耗时 | s/帧 | 10s@60fps 预估 |');
md.push('|---|---|---|---|---|---|---|');
for (const r of rows) {
  md.push(`| ${r.html} | ${r.size} | ${r.concurrency} | ${r.frames ?? '-'} | ${r.wall_s}s | ${r.s_per_frame ?? '-'} | ${r.est_10s_60fps_s ? r.est_10s_60fps_s + 's' : '-'} |`);
}
md.push('');
md.push('怎么读这张表：');
md.push('');
md.push('- `s/帧` 是**墙上时间 ÷ 帧数**，已经把并发算进去了，是「这支片子每帧要花多少」的真实数字。');
md.push('- 10s@60fps 预估 = `s/帧 × 600`。想渲一分钟的片子，把这个数乘 6。');
md.push('- 并发不是越大越好：超过 CPU 核数之后页面之间抢 CPU，s/帧 不降反升（表里能直接看出来）。');
md.push('- 画面越复杂越慢（每帧重建渐变 / 网格 / 大量文字都会加），所以拿**你自己那个页面**量一次最准。');
fs.writeFileSync(path.join(OUT_DIR, 'bench.md'), md.join('\n') + '\n', 'utf8');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清不掉就算了 */ }
console.log(`\n▸ bench.md / bench.json → ${OUT_DIR}`);

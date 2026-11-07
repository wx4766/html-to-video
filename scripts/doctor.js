#!/usr/bin/env node
/**
 * doctor.js · 出片前的环境自检
 * ---------------------------------------------------------------------------
 * 这个工具最劝退的一步不是写动画，是"第一次跑不起来"。而且失败信息往往
 * 与真实原因隔着两层：Playwright 版本不匹配报的是 "Executable doesn't exist"，
 * ffmpeg 缺 H.264 报的是 "Unknown encoder 'libx264'"，都很难一眼看出该怎么办。
 *
 * 所以把「要什么、现在有什么、不对怎么修」三件事一次说清，能自动修的直接给命令。
 * 它只读不写（除了打印），不会动你的环境。
 *
 * 用法：
 *   node scripts/doctor.js            # 人读清单
 *   node scripts/doctor.js --json     # 机器读（CI / Agent 用）
 *
 * 退出码：0 全部就绪 · 1 有阻塞项（渲染会失败）· 2 只有警告（能渲，但可能有坑）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const JSON_MODE = process.argv.includes('--json');
const checks = [];

function add(level, name, detail, fix) {
  checks.push({ level, name, detail: detail || '', fix: fix || '' });
}

/** 从"能 require 到"到"能真的启动"是两件事 —— 版本不匹配只有启动才会暴露 */
function detectPlaywright() {
  const tries = [];
  if (process.env.NODE_PATH) for (const p of process.env.NODE_PATH.split(path.delimiter)) tries.push(p);
  const ws = process.env.WB_NODE_WORKSPACE;
  if (ws) tries.push(path.join(ws, 'node_modules'));
  tries.push(path.join(__dirname, '..', 'node_modules'));
  tries.push(path.join(process.cwd(), 'node_modules'));

  for (const dir of tries) {
    const pkg = path.join(dir, 'playwright', 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const v = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
        const mod = require(path.join(dir, 'playwright'));
        const exe = mod.chromium.executablePath();
        return { dir, version: v, exe, exists: !!exe && fs.existsSync(exe) };
      } catch (e) {
        return { dir, version: '?', exe: null, exists: false, error: String(e.message || e) };
      }
    }
  }
  return null;
}

function detectFfmpeg() {
  const cands = [];
  if (process.env.FFMPEG) cands.push(process.env.FFMPEG);
  const ws = process.env.WB_NODE_WORKSPACE;
  if (ws) cands.push(path.join(ws, 'node_modules', '@ffmpeg-installer', 'ffmpeg'));
  cands.push(path.join(__dirname, '..', 'node_modules', '@ffmpeg-installer', 'linux-x64', 'ffmpeg'));
  cands.push('ffmpeg');

  for (const c of cands) {
    if (c !== 'ffmpeg' && !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const txt = String(r.stdout || '');
    return {
      bin: c,
      x264: /libx264/.test(txt),
      prores: /prores(?:_ks)?/.test(txt),
      gif: /gif/.test(txt),
    };
  }
  return null;
}

/* ── 1. Node ─────────────────────────────────────────────────────── */
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 18) add('ok', 'Node.js', `${process.versions.node}`);
else add('fail', 'Node.js', `${process.versions.node} 太旧`, '升级到 Node 18+（推荐 20/22）');

/* ── 2. Playwright + Chromium ────────────────────────────────────── */
const pw = detectPlaywright();
if (!pw) {
  add('fail', 'Playwright', '没找到（NODE_PATH / 工作区 / 项目 node_modules 都没有）',
    'bash scripts/install-deps.sh   # 自动探测本机浏览器缓存并装匹配版本');
} else if (!pw.exists) {
  add('fail', 'Playwright', `装了 ${pw.version}，但对应浏览器不存在：${pw.exe || '(未知路径)'}`,
    '版本与浏览器缓存不匹配。跑 node scripts/detect-env.js 看推荐版本，再 npm i -D playwright@<推荐版本>');
} else {
  add('ok', 'Playwright', `${pw.version} · ${pw.exe}`);
}

/* 真启动一次：require 成功不代表能跑（缺系统库时只有 launch 会报） */
if (pw && pw.exists) {
  try {
    const { chromium } = require(path.join(pw.dir, 'playwright'));
    const r = spawnSync(process.execPath, ['-e', `
      const { chromium } = require(${JSON.stringify(path.join(pw.dir, 'playwright'))});
      chromium.launch({ headless: true }).then(async b => { await b.close(); console.log('OK'); })
        .catch(e => { console.error(String(e.message||e)); process.exit(1); });
    `], { encoding: 'utf8', timeout: 30000 });
    if (/OK/.test(String(r.stdout))) add('ok', 'Chromium 启动', '无头模式可启动');
    else add('warn', 'Chromium 启动', String(r.stderr || r.stdout).split('\n').slice(0, 2).join(' '),
      'Linux 常见是缺系统库：apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libasound2');
  } catch (e) {
    add('warn', 'Chromium 启动', String((e && e.message) || e).slice(0, 160), '手动跑一次渲染看完整报错');
  }
}

/* ── 3. ffmpeg ───────────────────────────────────────────────────── */
const ff = detectFfmpeg();
if (!ff) {
  add('fail', 'ffmpeg', '没找到可用的 ffmpeg', 'npm i -D @ffmpeg-installer/ffmpeg（或用 FFMPEG=<绝对路径> 指定）');
} else {
  if (ff.x264 && ff.prores) add('ok', 'ffmpeg', `${ff.bin} · 含 libx264 + ProRes`);
  else {
    const miss = [!ff.x264 && 'libx264', !ff.prores && 'ProRes'].filter(Boolean).join(' / ');
    add('fail', 'ffmpeg', `${ff.bin} 缺少 ${miss}`,
      '系统包管理器装的 ffmpeg 常被裁掉编码器。用 @ffmpeg-installer/ffmpeg 的完整版，或设 FFMPEG=<完整版路径>');
  }
  if (!ff.gif) add('warn', 'ffmpeg · GIF', '这版 ffmpeg 可能不支持 GIF 编码', '--gif 会失败，其余功能不受影响');
}

/* ── 4. 字体（中文是硬需求） ─────────────────────────────────────── */
if (process.platform === 'linux') {
  const r = spawnSync('fc-list', [':lang=zh', 'family'], { encoding: 'utf8' });
  const fams = String(r.stdout || '').split('\n').filter(Boolean).slice(0, 3);
  if (fams.length) add('ok', '中文字体', fams.join(' / '));
  else add('warn', '中文字体', '没检测到中文字体，成片里的汉字会变方块',
    'apt-get install -y fonts-noto-cjk   # 或把字体文件放到 ~/.fonts 后 fc-cache -f');
} else {
  add('ok', '中文字体', '系统自带（Windows 微软雅黑 / macOS 苹方）');
}

/* ── 5. 磁盘 ─────────────────────────────────────────────────────── */
try {
  const st = fs.statfsSync(os.tmpdir());
  const freeGB = (st.bavail * st.bsize) / 1e9;
  if (freeGB >= 8) add('ok', '临时盘余量', `${freeGB.toFixed(1)} GB（${os.tmpdir()}）`);
  else add('warn', '临时盘余量', `${freeGB.toFixed(1)} GB 偏少`,
    '1080p 一分钟逐帧约 2.4 GB。渲染时用 --tmpdir 指到别的盘');
} catch (e) { add('ok', '临时盘余量', '无法读取（跳过）'); }

/* ── 6. 工作区配置 ───────────────────────────────────────────────── */
const envFile = path.join(os.homedir(), '.workbuddy', '.html2video-env');
if (fs.existsSync(envFile)) add('ok', '工作区配置', envFile);
else if (process.env.WB_NODE_WORKSPACE) add('ok', '工作区配置', 'WB_NODE_WORKSPACE=' + process.env.WB_NODE_WORKSPACE);
else add('warn', '工作区配置', '没有 ~/.workbuddy/.html2video-env',
  '只在用 bash assets/render.sh 时需要；直接用 node scripts/render-video-seek.js 不受影响');

/* ── 输出 ────────────────────────────────────────────────────────── */
const fails = checks.filter((c) => c.level === 'fail');
const warns = checks.filter((c) => c.level === 'warn');

if (JSON_MODE) {
  process.stdout.write(JSON.stringify({
    ok: fails.length === 0,
    node: process.versions.node,
    platform: process.platform,
    checks,
    fixes: fails.map((c) => c.fix).filter(Boolean),
  }) + '\n');
  process.exit(fails.length ? 1 : warns.length ? 2 : 0);
}

const mark = { ok: '✓', warn: '⚠', fail: '✗' };
console.log('\n▸ html-to-video · 环境自检\n');
for (const c of checks) {
  console.log(`  ${mark[c.level]} ${c.name.padEnd(16)} ${c.detail}`);
  if (c.level !== 'ok' && c.fix) console.log(`      → ${c.fix}`);
}
console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 项会阻塞渲染，${warns.length} 项警告。按上面的 → 修完再跑一次。`);
} else if (warns.length) {
  console.log(`⚠ ${warns.length} 项警告 —— 能渲，但可能踩坑。`);
} else {
  console.log('✓ 全部就绪，可以出片了。');
}
process.exit(fails.length ? 1 : warns.length ? 2 : 0);

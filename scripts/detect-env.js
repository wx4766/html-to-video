#!/usr/bin/env node
/**
 * 环境探测：本机 Playwright 浏览器缓存里有哪些 chromium build，该装哪个 playwright 版本。
 *
 * 为什么需要它：playwright-core@X 只认自己 browsers.json 里声明的 chromium build 号，
 * 版本不匹配就报 "Executable doesn't exist"。而某些网络环境下 chromium 下不下来，
 * 此时正确做法是「迁就已有缓存挑版本」，而不是硬装最新版再下载。
 *
 * 输出（shell 友好的 KEY=VALUE，供 install-deps.sh eval）：
 *   CACHE_DIR        浏览器缓存目录（可能为空）
 *   FOUND_BUILDS     逗号分隔的已有 build 号
 *   RECOMMEND_PW     建议安装的 playwright 版本（或 "latest"）
 *   RECOMMEND_REASON matched-cache | no-cache | unknown-build
 *   NEED_DOWNLOAD    1=需要下载浏览器，0=可复用缓存
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// chromium build → playwright 版本（够覆盖常见版本；未命中则走在线查询）
const BUILD_TO_PW = {
  1148: '1.49.1',
  1155: '1.50.1',
  1169: '1.52.0',
  1187: '1.55.0',
  1208: '1.58.0',
};

function cacheDirs() {
  const home = os.homedir();
  const cands = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) cands.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  switch (process.platform) {
    case 'win32':
      if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
      break;
    case 'darwin':
      cands.push(path.join(home, 'Library', 'Caches', 'ms-playwright'));
      break;
    default:
      cands.push(path.join(home, '.cache', 'ms-playwright'));
      break;
  }
  cands.push(path.join(home, '.cache', 'ms-playwright'));
  return cands;
}

function findBuilds() {
  const dirs = cacheDirs();
  let cacheDir = '';
  for (const d of dirs) {
    if (d && fs.existsSync(d)) { cacheDir = d; break; }
  }
  if (!cacheDir) return { cacheDir: '', builds: [] };

  const builds = new Set();
  let entries = [];
  try { entries = fs.readdirSync(cacheDir); } catch (e) { return { cacheDir, builds: [] }; }
  for (const name of entries) {
    // chromium-1148 / chromium_headless_shell-1148 / chromium-1148-old 等
    const m = /^chromium(?:_headless_shell)?-(\d+)/.exec(name);
    if (m) {
      const full = path.join(cacheDir, name);
      let isDir = false;
      try { isDir = fs.statSync(full).isDirectory(); } catch (e) { isDir = false; }
      if (isDir) builds.add(parseInt(m[1], 10));
    }
  }
  return { cacheDir, builds: Array.from(builds).sort((a, b) => a - b) };
}

function main() {
  const { cacheDir, builds } = findBuilds();

  if (!builds.length) {
    emit({
      CACHE_DIR: cacheDir,
      FOUND_BUILDS: '',
      RECOMMEND_PW: 'latest',
      RECOMMEND_REASON: 'no-cache',
      NEED_DOWNLOAD: '1',
    });
    return;
  }

  // 优先迁移最大的 build（新版本通常兼容性更好），找得到映射就用
  const sortedDesc = builds.slice().sort((a, b) => b - a);
  for (const b of sortedDesc) {
    if (BUILD_TO_PW[b]) {
      emit({
        CACHE_DIR: cacheDir,
        FOUND_BUILDS: builds.join(','),
        RECOMMEND_PW: BUILD_TO_PW[b],
        RECOMMEND_REASON: 'matched-cache',
        NEED_DOWNLOAD: '0',
      });
      return;
    }
  }

  // 缓存里有 build，但内置表不认识 —— 装最新版并下载浏览器更稳
  emit({
    CACHE_DIR: cacheDir,
    FOUND_BUILDS: builds.join(','),
    RECOMMEND_PW: 'latest',
    RECOMMEND_REASON: 'unknown-build',
    NEED_DOWNLOAD: '0',
  });
}

/**
 * 输出必须做 shell 单引号转义再交给 eval。
 * 缓存路径常含撇号（Windows 用户名带撇号时，如 C:\Users\o'brien\...），裸输出会让 eval 报
 * "unexpected EOF while looking for matching `'" —— 踩过。
 */
function shquote(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

function emit(obj) {
  for (const k of Object.keys(obj)) {
    process.stdout.write(`${k}=${shquote(obj[k])}\n`);
  }
}

main();

/**
 * 测试公用件：定位脚本、补齐依赖路径、跑子进程。
 *
 * 依赖可能装在两处，两种都得能跑：
 *   ① 仓库自己的 node_modules —— `npm install` 之后（CI 走这条）
 *   ② ~/.workbuddy 下的 node 工作区 —— install-deps.sh 的默认位置（本机走这条）
 * 这里把路径补齐后交给子进程，测试文件自身不 require playwright。
 *
 * 注意文件名不能叫 test-*.mjs / *.test.mjs —— 那会被 node --test 当成测试文件。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RENDER = path.join(ROOT, 'scripts', 'render-video-seek.js');
export const QA = path.join(ROOT, 'scripts', 'qa.js');
export const TEMPLATES = path.join(ROOT, 'assets', 'templates');

const FFMPEG_REL = [
  '@ffmpeg-installer/win32-x64/ffmpeg.exe',
  '@ffmpeg-installer/linux-x64/ffmpeg',
  '@ffmpeg-installer/darwin-x64/ffmpeg',
  '@ffmpeg-installer/darwin-arm64/ffmpeg',
];

/**
 * 读 ~/.workbuddy/.html2video-env 里的 WB_NODE_WORKSPACE。
 * 注意：路径**可能含撇号**（例如 C:/Users/o'brien/...），
 * 用 [^"']+ 这种字符集会把它截断 —— 已经踩过一次。改为整行取值再剥引号。
 */
function workspaceFromEnvFile() {
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.workbuddy', '.html2video-env'), 'utf8');
    const m = txt.match(/WB_NODE_WORKSPACE\s*=\s*(.*)/);
    if (!m) return null;
    const v = m[1].trim().replace(/^["']/, '').replace(/["']\s*$/, '');
    return v || null;
  } catch {
    return null;
  }
}

export function toolEnv() {
  const env = { ...process.env };
  const dirs = [path.join(ROOT, 'node_modules')];
  const ws = env.WB_NODE_WORKSPACE || workspaceFromEnvFile();
  if (ws) dirs.push(path.join(ws, 'node_modules'));

  if (!env.NODE_PATH) env.NODE_PATH = dirs.join(path.delimiter);
  if (!env.FFMPEG) {
    for (const d of dirs) {
      const hit = FFMPEG_REL.map((rel) => path.join(d, rel)).find((p) => fs.existsSync(p));
      if (hit) { env.FFMPEG = hit; break; }
    }
  }
  return env;
}

export function run(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: toolEnv(),
    timeout: opts.timeout ?? 240000,
    cwd: opts.cwd ?? ROOT,
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

export function tmpdir(prefix = 'h2v-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 把模板连同它引用的**同目录脚本**一起拷到目标位置。
 *
 * 模板不是永远单文件：`themes.js` 是共用脚本（`<script src="./themes.js">`），
 * 只拷 HTML 会 404 —— 而渲染器把「页面报错」判为失败，于是测试挂在
 * 「Failed to load resource: 404」这种和被测行为毫无关系的错误上。
 * 这里按源码里真实出现的 `./xxx.js` 去拷，以后再加共用脚本也不用改测试。
 */
const SIBLING_SCRIPT = /<script[^>]+src\s*=\s*["']\.\/([^"'/\\]+\.js)["']/g;

export function copyTemplate(name, destFile) {
  const src = path.join(TEMPLATES, name);
  fs.copyFileSync(src, destFile);
  const dir = path.dirname(destFile);
  const code = fs.readFileSync(src, 'utf8');
  const copied = [];
  for (const m of code.matchAll(SIBLING_SCRIPT)) {
    const sib = path.join(TEMPLATES, m[1]);
    if (!fs.existsSync(sib)) continue;
    fs.copyFileSync(sib, path.join(dir, m[1]));
    copied.push(m[1]);
  }
  return { file: destFile, siblings: copied };
}

/** 从 ffmpeg -i 的输出里读分辨率 —— 用来验证 --width/--height 真的生效 */
export function probeSize(file) {
  const r = spawnSync(toolEnv().FFMPEG || 'ffmpeg', ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = (r.stderr || '').match(/,\s(\d{2,5})x(\d{2,5})\b/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** 读 qa.md 的指标行（列序固定：运动/静止/静止%/跳变/耗时/确定性/框景/报错） */
export function readQaRow(outDir) {
  const md = fs.readFileSync(path.join(outDir, 'qa.md'), 'utf8');
  const line = md.split('\n').find((l) => /^\|\s*[0-9]/.test(l));
  if (!line) return null;
  const cells = line.split('|').map((s) => s.trim()).filter(Boolean);
  return {
    motion: cells[0], still: cells[1], stillPct: cells[2], spikes: cells[3],
    cost: cells[4], deterministic: cells[5], frameIssues: cells[6], pageErrors: cells[7],
  };
}

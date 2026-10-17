/**
 * 字幕时间轴解析：SRT / WebVTT / JSON
 * ---------------------------------------------------------------------------
 * 统一输出 [{ index, start, end, text }]，时间单位是秒（浮点）。
 * 只做一件事：把文件变成确定的数组。不依赖第三方库。
 *
 * 支持的写法：
 *   SRT     序号可选、时间戳 ',' 或 '.' 分隔毫秒、多行文本合并成一行
 *   VTT     以 WEBVTT 开头即可，其余同 SRT（忽略样式标签）
 *   JSON    [{ "start":0.5, "end":2.3, "text":"..." }] 或 { "cues":[...] }
 *
 * 明确不做：自动断句、时间对齐、语音识别。输入什么就是什么。
 */

const fs = require('fs');
const path = require('path');

// SRT 是 HH:MM:SS,mmm，VTT 允许省掉小时写成 MM:SS.mmm —— 小时设为可选
const TIME_RE = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function toSeconds(h, m, s, ms) {
  const frac = ms.length === 1 ? ms / 10 : ms.length === 2 ? ms / 100 : ms / 1000;
  return parseInt(h || '0', 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + frac;
}

function parseOneLineTime(str) {
  const m = TIME_RE.exec(str);
  if (!m) return null;
  return toSeconds(m[1], m[2], m[3], m[4]);
}

/** SRT / VTT */
function parseText(raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0])) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(lines[0])) continue;   // VTT 元数据块

    // 找 "-->" 那一行；序号行可能不存在，所以从头扫
    let arrowAt = -1;
    for (let i = 0; i < lines.length && i < 3; i++) {
      if (lines[i].includes('-->')) { arrowAt = i; break; }
    }
    if (arrowAt === -1) continue;

    const [lhs, rhs] = lines[arrowAt].split('-->');
    const start = parseOneLineTime(lhs || '');
    const end = parseOneLineTime(rhs || '');
    if (start === null || end === null) continue;

    // 时间行之后的内容是正文（VTT 的排版设置跟在时间行同一行，不会跑到这里）
    const content = lines.slice(arrowAt + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!content) continue;

    out.push({ start, end, text: content });
  }
  return out;
}

/** JSON */
function parseJson(raw) {
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.cues) ? data.cues : null);
  if (!list) throw new Error('JSON 应该是数组，或 {"cues": [...]}');
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const start = Number(item.start ?? item.from ?? item.begin);
    const end = Number(item.end ?? item.to ?? item.finish);
    const text = String(item.text ?? item.content ?? '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue;
    out.push({ start, end, text });
  }
  return out;
}

/**
 * @param {string} file 字幕文件路径
 * @returns {Array<{index:number,start:number,end:number,text:string}>}
 */
function loadCues(file) {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(abs).toLowerCase();
  let cues;
  if (ext === '.json') {
    cues = parseJson(raw);
  } else {
    cues = parseText(raw);
    // 内容看起来像 JSON 但扩展名不是 .json，也给它一次机会
    if (!cues.length && /^\s*[\[{]/.test(raw)) {
      try { cues = parseJson(raw); } catch (e) { /* 还是按文本处理 */ }
    }
  }

  cues.sort((a, b) => a.start - b.start);

  // 修正逻辑：时长非正、重叠的，都按时间轴硬修，宁可少一句也不让画面抽搐
  const fixed = [];
  for (const c of cues) {
    let { start, end, text } = c;
    if (!(end > start)) end = start + 0.6;
    if (fixed.length && start < fixed[fixed.length - 1].end) {
      start = fixed[fixed.length - 1].end;
      if (!(end > start)) continue;
    }
    fixed.push({ start, end, text });
  }

  return fixed.map((c, i) => ({ index: i, start: c.start, end: c.end, text: c.text }));
}

/** 给定时刻落在哪一句（找不到返回 null） */
function cueAt(cues, t) {
  for (const c of cues) {
    if (t >= c.start && t < c.end) return c;
  }
  return null;
}

module.exports = { loadCues, cueAt, parseText, parseJson };

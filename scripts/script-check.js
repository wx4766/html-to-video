#!/usr/bin/env node
'use strict';
/* =========================================================================
   script-check.js —— 文案自检
   -------------------------------------------------------------------------
   为什么需要它：渲染器能保证"字画得出来"，但保证不了"字读得完"。
   实际翻车过的：

     · 一镜塞 5 条要点，观众读到第 3 条时画面已经切了
     · 单行 22 个汉字，模板自动缩到 38px，投到手机上是一团灰
     · 全片 18 秒写了 380 字，等于让人以 21 字/秒的速度阅读
     · "赋能 / 闭环 / 极致体验" —— 听起来像 PPT 生成器

   这些都是可数的。判据来自 references/writing.md（方法取自 cinecode，MIT）。

   用法：
     node scripts/script-check.js story.json
     node scripts/script-check.js story.json --vertical     # 竖屏按 12 字/行算
     node scripts/script-check.js story.json --json

   退出码：0 = 只有提示 / 1 = 有硬问题（超限、陈词滥调）
   ========================================================================= */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const JSON_OUT = argv.includes('--json');
const VERTICAL = argv.includes('--vertical');

if (!file) {
  console.log(`script-check · 文案自检

  node scripts/script-check.js <story.json> [选项]

  --vertical    竖屏（单行上限 12 字，横屏 14）
  --json        结构化输出

  检查：每镜字数 / 单行上限 / 每秒阅读字数 / 陈词滥调 / 是否有转折
  规则说明：references/writing.md`);
  process.exit(2);
}
if (!fs.existsSync(file)) { console.error(`✗ 没有这个文件：${file}`); process.exit(2); }

let story;
try {
  story = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`✗ JSON 解析失败：${e.message}`);
  process.exit(2);
}
if (!Array.isArray(story)) { console.error('✗ story 应该是一个数组（每个元素一个镜头）'); process.exit(2); }

/* ---------- 词表 ---------- */
const CLICHE = [
  '在这个时代', '随着', '众所周知', '让我们', '今天我想', '总而言之', '值得一提',
  '不难发现', '由此可见', '综上所述', '赋能', '抓手', '闭环', '生态', '颠覆', '革新',
  '全新升级', '极致体验', '匠心智造', '见证', '未来已来', '无限可能', '开启新篇章', '重新定义',
];
/* 转折词：有任何一个，就认为文案里存在"拐点"（机械判断，只当提示） */
const TURN_WORDS = ['但', '却', '反而', '其实', '原来', '不是', '不再', '直到', '除了', '除非'];

const META = new Set(['id', 'dur', 'camera', 'style', 'theme', 'trans', 'role', 'name', 'type', 'label', 'unit', 'value', 'n']);

const hanCount = (s) => (String(s).match(/[\u4e00-\u9fa5]/g) || []).length;

function stringsOf(obj, out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (META.has(k)) continue;
    if (typeof v === 'string') out.push({ key: k, text: v });
    else if (Array.isArray(v)) v.forEach((x) => { if (typeof x === 'string') out.push({ key: k, text: x }); });
  }
  return out;
}

const LINE_MAX = VERTICAL ? 12 : 14;
const READ_PER_SEC = 12;          // 屏幕字阅读速度上限（汉字/秒）
const problems = [];
const notes = [];

let totalDur = 0;
let totalChars = 0;
const perShot = [];

story.forEach((shot, i) => {
  const dur = Number(shot.dur) > 0 ? Number(shot.dur) : 3;
  totalDur += dur;

  const items = stringsOf(shot);
  /* items / bars 这类数组里的对象，也要把 t/d/label 抽出来 */
  for (const k of ['items', 'bars']) {
    if (Array.isArray(shot[k])) {
      for (const it of shot[k]) {
        if (!it || typeof it !== 'object') continue;
        if (it.t) items.push({ key: k + '.t', text: it.t });
        if (it.d) items.push({ key: k + '.d', text: it.d });
        if (it.label) items.push({ key: k + '.label', text: it.label });
      }
    }
  }
  if (shot.before && typeof shot.before === 'object') {
    for (const f of ['title', 'note', 'label']) if (shot.before[f]) items.push({ key: 'before.' + f, text: shot.before[f] });
  }
  if (shot.after && typeof shot.after === 'object') {
    for (const f of ['title', 'note', 'label']) if (shot.after[f]) items.push({ key: 'after.' + f, text: shot.after[f] });
  }

  const chars = items.reduce((a, it) => a + hanCount(it.text), 0);
  totalChars += chars;

  /* 单行超限 */
  for (const it of items) {
    const n = hanCount(it.text);
    if (n > LINE_MAX) {
      problems.push(`第 ${i + 1} 镜（${shot.id || '?'}）的 ${it.key} 有 ${n} 个汉字 > ${LINE_MAX}：「${it.text.slice(0, 24)}」`);
    }
  }
  /* 条目数 */
  const bulletCount = Array.isArray(shot.items) ? shot.items.length : 0;
  if (bulletCount > 4) {
    problems.push(`第 ${i + 1} 镜（${shot.id || '?'}）有 ${bulletCount} 条要点：读到第 4 条时观众已经在看下一镜了`);
  }
  /* 陈词滥调 */
  const all = items.map((it) => it.text).join(' ');
  const hits = CLICHE.filter((w) => all.includes(w));
  for (const w of hits) problems.push(`第 ${i + 1} 镜出现陈词滥调「${w}」——换成一个具体动作或数字`);

  perShot.push({ index: i + 1, id: shot.id || 'shot' + (i + 1), dur, chars, bullets: bulletCount, items: items.length });
});

/* 阅读速度 */
const cps = totalDur > 0 ? totalChars / totalDur : 0;
if (cps > READ_PER_SEC) {
  problems.push(`全片 ${totalChars} 字 / ${totalDur.toFixed(1)} 秒 = ${cps.toFixed(1)} 字每秒，超过阅读上限 ${READ_PER_SEC}：删掉约 ${Math.round(totalChars - totalDur * READ_PER_SEC)} 字`);
} else {
  notes.push(`阅读速度 ${cps.toFixed(1)} 字/秒（上限 ${READ_PER_SEC}）`);
}

/* 转折 */
const hasCompare = story.some((s) => s.id === 'compare' || s.before || s.after);
const hasTurnWord = story.some((s) => TURN_WORDS.some((w) => stringsOf(s).some((it) => it.text.includes(w))));
if (!hasCompare && !hasTurnWord) {
  notes.push('没有找到转折（既没有 compare 镜头，也没有「但/却/反而/其实」这类词）。情绪片可以没有，说明片则通常需要一下拐点');
} else {
  notes.push(hasCompare ? '有转折镜头（compare）' : '文案里有转折词');
}

/* 空镜 */
const empty = story.filter((s) => stringsOf(s).length === 0 && !s.value);
if (empty.length) notes.push(`${empty.length} 个镜头没有任何文字（纯画面对比/数据视觉可以，但确认是有意的）`);

/* ---------- 输出 ---------- */
const ok = problems.length === 0;
if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    file, shots: story.length, duration: +totalDur.toFixed(2), chars: totalChars,
    charsPerSecond: +cps.toFixed(2), lineMax: LINE_MAX, perShot, problems, notes, ok,
  }, null, 2) + '\n');
} else {
  console.log(`\nscript-check · ${path.basename(file)}`);
  console.log('─'.repeat(58));
  console.log(`  ${story.length} 镜 / ${totalDur.toFixed(1)}s / ${totalChars} 字 / ${cps.toFixed(1)} 字每秒`);
  console.log('');
  for (const s of perShot) {
    const flag = s.chars > s.dur * READ_PER_SEC ? '⚠' : ' ';
    console.log(`  ${flag} ${String(s.index).padStart(2)}. ${s.id.padEnd(10)} ${String(s.dur).padStart(4)}s  ${String(s.chars).padStart(3)} 字${s.bullets ? `  ${s.bullets} 条` : ''}`);
  }
  console.log('');
  if (problems.length) {
    console.log('✗ 要改的：');
    for (const p of problems) console.log('   · ' + p);
  }
  if (notes.length) {
    console.log('· 提示：');
    for (const n of notes) console.log('   · ' + n);
  }
  console.log('');
  console.log(ok ? '✓ 没有硬问题' : `✗ ${problems.length} 处要改（规则见 references/writing.md）`);
}
process.exit(ok ? 0 : 1);

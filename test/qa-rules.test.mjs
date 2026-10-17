// qa.js 判据的单测：这些阈值逻辑之前一行测试都没有，改一个数就没人知道是修好还是漏掉。
// 只测纯函数（lib/qa-rules.cjs），不启浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { frameIssues, persistent, mean, median, mergeLines } = require('../scripts/lib/qa-rules.cjs');

/* ── frameIssues ─────────────────────────────────────────────── */

test('框景：正常文字不报任何问题', () => {
  const boxes = [
    ['标题', 0.1, 0.2, 0.5, 0.26, false],
    ['副标题', 0.1, 0.3, 0.6, 0.34, false],
  ];
  assert.deepEqual(frameIssues(boxes, 0.15), []);
});

test('框景：右半出界算半截字', () => {
  // 框从 0.8 到 1.2，可见部分 (1-0.8)/0.4 = 50%
  const out = frameIssues([['越界标题', 0.8, 0.2, 1.2, 0.26, false]], 0.15);
  assert.deepEqual(out, [['半截字', '越界标题']]);
});

test('框景：只擦掉一点点边（可见 95%）不算半截字', () => {
  const out = frameIssues([['贴边标题', 0.05, 0.2, 1.02, 0.26, false]], 0.15);
  assert.deepEqual(out, []);
});

test('框景：整个在画外不报（镜头没拍到，不是穿帮）', () => {
  const out = frameIssues([['画外', 1.1, 0.2, 1.5, 0.26, false]], 0.15);
  assert.deepEqual(out, []);
});

test('框景：底边进字幕带会报', () => {
  // band=0.15 → 从 y=0.854 起算字幕带（含 0.004 容差）
  const out = frameIssues([['底部文字', 0.1, 0.90, 0.5, 0.96, false]], 0.15);
  assert.deepEqual(out, [['进字幕带', '底部文字']]);
});

test('框景：band=0 时不检查字幕带', () => {
  const out = frameIssues([['底部文字', 0.1, 0.90, 0.5, 0.96, false]], 0);
  assert.deepEqual(out, []);
});

test('框景：同一串文字画两遍（描边+填色）不算叠字', () => {
  const boxes = [
    ['标题', 0.1, 0.2, 0.5, 0.26, false],
    ['标题', 0.1, 0.2, 0.5, 0.26, false],
  ];
  assert.deepEqual(frameIssues(boxes, 0.15), []);
});

test('框景：两串不同的字重叠超过 30% 算叠字', () => {
  const boxes = [
    ['标题', 0.1, 0.2, 0.5, 0.30, false],
    ['副标题', 0.15, 0.24, 0.45, 0.28, false],   // 完全落在标题框里
  ];
  const out = frameIssues(boxes, 0.15);
  assert.equal(out.filter(x => x[0] === '叠字').length, 1);
});

test('框景：clip 里的字不参与叠字（滚动数字、按笔顺揭开的字外框偏大）', () => {
  const boxes = [
    ['可见标题', 0.1, 0.2, 0.5, 0.30, false],
    ['clip 里的字', 0.15, 0.24, 0.45, 0.28, true],
  ];
  assert.deepEqual(frameIssues(boxes, 0.15), []);
});

test('框景：太小的字（高 < 0.8%）忽略，免得把标点当问题', () => {
  const out = frameIssues([['，', 0.5, 0.5, 0.51, 0.505, false]], 0.15);
  assert.deepEqual(out, []);
});

/* ── persistent ──────────────────────────────────────────────── */

test('持续：连续出现够久才报', () => {
  const ts = [0, 1, 2, 3, 4];
  const per = [[['半截字', 'A']], [['半截字', 'A']], [['半截字', 'A']], [['半截字', 'A']], [['半截字', 'A']]];
  const runs = persistent(ts, per, 2);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], { kind: '半截字', text: 'A', lt: [0, 4] });
});

test('持续：只闪一帧不报（交给跳变指标）', () => {
  const ts = [0, 1, 2];
  const per = [[], [['半截字', 'A']], []];
  assert.deepEqual(persistent(ts, per, 2), []);
});

test('持续：中间断开算两段', () => {
  const ts = [0, 1, 2, 3, 4, 5];
  const per = [
    [['半截字', 'A']], [['半截字', 'A']], [],
    [['半截字', 'A']], [['半截字', 'A']], [['半截字', 'A']],
  ];
  const runs = persistent(ts, per, 1);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].lt, [0, 1]);
  assert.deepEqual(runs[1].lt, [3, 5]);
});

test('持续：不同问题各自计时', () => {
  const ts = [0, 1, 2];
  const per = [
    [['半截字', 'A'], ['叠字', 'B|C']],
    [['半截字', 'A']],
    [['半截字', 'A']],
  ];
  const runs = persistent(ts, per, 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, '半截字');
});

test('持续：结果按起始时间排序', () => {
  const ts = [0, 1, 2, 3];
  const per = [
    [['叠字', 'X|Y']],
    [['叠字', 'X|Y'], ['半截字', 'Z']],
    [['叠字', 'X|Y'], ['半截字', 'Z']],
    [['叠字', 'X|Y'], ['半截字', 'Z']],
  ];
  const runs = persistent(ts, per, 2);
  assert.deepEqual(runs.map(r => r.lt[0]), [0, 1]);
});

/* ── mergeLines（DOM 文字按视觉行分块）────────────────────────── */

test('分块：同一行上的两个片段合并成一块', () => {
  // 「前缀文字」+ 行内强调，同一条基线上，水平紧邻
  const frags = [
    ['前缀文字', 160, 820, 320, 868],
    ['中间强调', 320, 820, 480, 868],
  ];
  const lines = mergeLines(frags);
  assert.equal(lines.length, 1, '同一行不该拆成两块');
  assert.deepEqual([lines[0][1], lines[0][3]], [160, 480], '横向范围应是两段的并集');
});

test('分块：多行段落一行一块，不跨行合并', () => {
  const frags = [
    ['第一行', 160, 520, 800, 568],
    ['第二行', 160, 570, 780, 618],
    ['第三行', 160, 620, 700, 668],
  ];
  const lines = mergeLines(frags);
  assert.equal(lines.length, 3);
});

test('分块：行距极紧（行框轻微重叠）仍算两行', () => {
  // line-height < 1 时相邻行的行框会重叠几个像素，但远不到「较矮者一半」
  const frags = [
    ['上行', 100, 100, 600, 190],
    ['下行', 100, 178, 600, 268],   // 重叠 12px，行高 90 → 13%
  ];
  assert.equal(mergeLines(frags).length, 2);
});

test('分块：左右两栏同一水平线不合并（间隙太大）', () => {
  const frags = [
    ['左栏文字', 100, 300, 500, 350],
    ['右栏文字', 1200, 300, 1700, 350],   // 缝 700px，行高 50 → 14 倍
  ];
  assert.equal(mergeLines(frags).length, 2);
});

test('分块：行内多段文字最终仍是一块（避免自判叠字）', () => {
  // 段落一行里夹着 span —— 旧实现取整段并集会把这行和 span 判成叠字
  const lines = mergeLines([
    ['确定性渲染意味着', 160, 520, 700, 568],
    ['同一份代码', 700, 520, 960, 568],
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0][0], /确定性渲染意味着/);
  assert.match(lines[0][0], /同一份代码/);
});

test('分块：空输入不炸', () => {
  assert.deepEqual(mergeLines([]), []);
  assert.deepEqual(mergeLines([], 3), []);
});

/* ── 统计工具 ────────────────────────────────────────────────── */

test('median：奇偶长度都对', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

test('mean：空数组返回 0 而不是 NaN', () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([]), 0);
});

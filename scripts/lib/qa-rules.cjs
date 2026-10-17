/**
 * QA 判据里可以脱离浏览器跑的纯逻辑。
 * 抽出来是为了能被 test/ 单测覆盖 —— 之前这些阈值逻辑一行测试都没有，
 * 改一个数就没人知道是「修好了」还是「漏掉了」。
 *
 * 输入输出都是普通对象/数组，不碰 DOM、不碰 canvas、不碰 fs。
 */

/**
 * 框景判定（纯几何）
 * @param {Array<[string, number, number, number, number, boolean]>} boxes
 *        [文字, x0, y0, x1, y1, 是否在 clip 里]，坐标已归一化到 0–1
 * @param {number} band 底部字幕带高度（占画面比例，0 表示不检查）
 * @returns {Array<[string, string]>} 形如 [['半截字', '标题文字'], ...]
 */
function frameIssues(boxes, band) {
  const out = [], vis = [];
  for (const [txt, x0, y0, x1, y1, clipped] of boxes) {
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0 || h < 0.008) continue;              // 太小（<~9px）不管
    const ix0 = Math.max(x0, 0), iy0 = Math.max(y0, 0);
    const ix1 = Math.min(x1, 1), iy1 = Math.min(y1, 1);
    if (ix1 <= ix0 || iy1 <= iy0) continue;                    // 整个在画外（镜头没拍到）
    const frac = (ix1 - ix0) * (iy1 - iy0) / (w * h);
    if (frac < 0.9 && frac > 0.1) out.push(['半截字', txt]);
    if (band > 0 && iy1 > 1 - band + 0.004 && frac > 0.1) out.push(['进字幕带', txt]);
    if (!clipped) vis.push([txt, x0, y0, x1, y1]);
  }
  // 叠字：两串不同的字外框重叠面积占小块面积 > 30%
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const A = vis[i], B = vis[j];
      if (A[0] === B[0]) continue;                             // 同一串画两遍（描边＋填色、投影）
      const ow = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
      const oh = Math.min(A[4], B[4]) - Math.max(A[2], B[2]);
      if (ow <= 0 || oh <= 0) continue;
      const small = Math.min((A[3] - A[1]) * (A[4] - A[2]), (B[3] - B[1]) * (B[4] - B[2]));
      if (small > 0 && ow * oh / small > 0.3) out.push(['叠字', A[0] + '｜' + B[0]]);
    }
  }
  return out;
}

/**
 * 同一个问题连续出现够久才报（镜头摇过去那几帧的半截字是正常的）。
 * minS 跟着采样间隔走：采得稀时报得保守些，免得把一帧的偶然当问题。
 * 单帧闪一下就过的穿帮交给「跳变」指标，不在这里报。
 *
 * @param {number[]} ts 采样时刻
 * @param {Array<Array<[string,string]>>} perFrame 每帧的 issues
 * @param {number} minS 最短持续时间
 */
function persistent(ts, perFrame, minS) {
  const runs = [], open = new Map();
  perFrame.forEach((list, k) => {
    const cur = new Set(list.map(x => x[0] + '\u0000' + x[1]));
    for (const key of [...open.keys()]) {
      if (!cur.has(key)) {
        const [t0, t1] = open.get(key); open.delete(key);
        if (t1 - t0 >= minS) runs.push([key, t0, t1]);
      }
    }
    for (const key of cur) {
      if (open.has(key)) open.set(key, [open.get(key)[0], ts[k]]);
      else open.set(key, [ts[k], ts[k]]);
    }
  });
  for (const [key, [t0, t1]] of open) if (t1 - t0 >= minS) runs.push([key, t0, t1]);
  return runs.sort((a, b) => a[1] - b[1]).map(([k, t0, t1]) => {
    const [kind, txt] = k.split('\u0000');
    return { kind, text: txt, lt: [+t0.toFixed(2), +t1.toFixed(2)] };
  });
}

/**
 * 把 DOM 文字片段按「视觉行」合并成块。
 *
 * 输入 [标签, left, top, right, bottom]，可以是像素也可以是归一化坐标，只比相对关系。
 *
 * 为什么需要它：一个行内 <span> 和裸文字是**两个**文本节点，却站在同一行上；
 * 一个多行段落是**一个**文本节点，却占了好几行。按节点分块两种都不对 ——
 * 前者把一行拆成两块互判「叠字」，后者把多行的并集框包住行内 span，也判「叠字」。
 * 只有按行合并不误报也不丢行。
 *
 * 判同行的两条：竖直重叠 > 较矮者一半；水平间隙 <= 2.5 倍行高（防止左右两栏被错并）。
 *
 * @param {Array<[string, number, number, number, number]>} frags
 * @param {number} [gapFactor=2.5] 水平间隙容差 / 行高
 * @returns {Array<[string, number, number, number, number]>}
 */
function mergeLines(frags, gapFactor) {
  const g = gapFactor || 2.5;
  const lines = [];
  for (const f of frags) {
    let hit = null;
    for (const L of lines) {
      const hA = L[4] - L[2], hB = f[4] - f[2];
      const ov = Math.min(L[4], f[4]) - Math.max(L[2], f[2]);
      if (ov <= Math.min(hA, hB) * 0.5) continue;
      const gap = Math.max(f[1] - L[3], L[1] - f[3]);   // >0 表示两段之间有缝
      if (gap > g * Math.max(hA, hB)) continue;
      hit = L;
      break;
    }
    if (!hit) { lines.push([f[0], f[1], f[2], f[3], f[4]]); continue; }
    hit[1] = Math.min(hit[1], f[1]);
    hit[2] = Math.min(hit[2], f[2]);
    hit[3] = Math.max(hit[3], f[3]);
    hit[4] = Math.max(hit[4], f[4]);
    if (hit[0] !== f[0]) {
      const parts = hit[0].split('｜');
      if (parts.length < 3 && !parts.includes(f[0])) hit[0] += '｜' + f[0];
    }
  }
  return lines;
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

module.exports = { frameIssues, persistent, mean, median, mergeLines };

/**
 * 运镜 CAM —— 让静止的画面「有镜头」。
 *
 * 为什么需要它：图表 / 文字铺满之后，画面很容易进入「死」状态 —— 元素都到位了，
 * 剩下几秒没有任何变化，观众第一反应是「视频卡住了」。加一点持续运镜
 * （缓慢推拉、轻微漂浮、极轻的手持抖动）就能活过来，而且比加装饰元素更不抢戏。
 *
 * 自带的手持抖动用的是**确定性伪噪声**（正弦叠加 + 固定种子），不是 Math.random()：
 *   · 同输入同输出，并行 worker 渲出来的帧完全一致
 *   · 抖动频率、幅度都能调，不会变成「地震」
 *
 * 用法：
 *   <script src="../lib/camera.js"></script>
 *   const cam = CAM.kenburns({ from:[0.02,-0.01,1.00], to:[-0.03,0.02,1.08], ease:MO.smooth });
 *
 *   // 每帧：先铺底（运镜会露边），再套运镜画内容，最后收掉
 *   g.fillStyle = TH.bg; g.fillRect(0,0,W,H);
 *   const tr = CAM.at(cam, t, W, H);
 *   CAM.push(g, tr, W, H);
 *   drawContent(g);
 *   CAM.pop(g);
 *
 * 约定：
 *   1. 运镜会把画面缩放/平移，**先铺满底色**再套运镜，否则边缘会露出黑边（或上一帧的残影）。
 *   2. 缩放 < 1 一定会露边。要「拉远」就先把内容画得比视口大（overscan 1.15 之类）。
 *   3. 手持抖动幅度按经验取 3–8 px（1080p），超过 12 px 就开始晕。
 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /**
   * 确定性伪噪声，值域约 [-1, 1]。
   * 三个互质频率叠加，看起来不规则但完全可复现 —— 同一个 seed 每次跑都一样。
   */
  function noise(seed, t) {
    const s = (seed || 0) * 1.0;
    return (
      0.60 * Math.sin(t * 1.7 + s * 12.9898) +
      0.28 * Math.sin(t * 3.1 + s * 78.2330) +
      0.12 * Math.sin(t * 5.3 + s * 39.4250)
    );
  }

  /** 空变换（什么都不做） */
  const IDENTITY = { dx: 0, dy: 0, scale: 1, rot: 0 };

  /**
   * 求某时刻的变换。返回 { dx, dy, scale, rot }：
   *   dx/dy 像素位移（已按 W/H 归一化比例换算成像素）
   *   scale 缩放，rot 旋转弧度
   */
  function at(cam, t, W, H) {
    if (!cam) return { ...IDENTITY };
    const w = W || 1920, h = H || 1080;
    const ease = cam.ease || ((x) => x);
    // loop = 一个完整来回的周期（去了再回）：t=0 与 t=loop 取值相同，不会漂
    const p = cam.loop
      ? (() => {
          const q = (((t % cam.loop) + cam.loop) % cam.loop) / cam.loop;
          return q < 0.5 ? q * 2 : 2 - q * 2;
        })()
      : clamp((t - (cam.t0 || 0)) / (cam.dur || 1));
    const e = ease(p);
    const out = { dx: 0, dy: 0, scale: 1, rot: 0 };

    switch (cam.kind) {
      case 'kenburns': {
        const [x0, y0, s0] = cam.from || [0, 0, 1];
        const [x1, y1, s1] = cam.to || [0, 0, 1];
        // 位移按画面尺寸比例走，缩放直接插值
        out.dx = lerp(x0, x1, e) * w;
        out.dy = lerp(y0, y1, e) * h;
        out.scale = lerp(s0, s1, e);
        break;
      }
      case 'pan': {
        const [x0, y0] = cam.from || [0, 0];
        const [x1, y1] = cam.to || [0, 0];
        out.dx = lerp(x0, x1, e) * w;
        out.dy = lerp(y0, y1, e) * h;
        break;
      }
      case 'zoom': {
        const [cx, cy] = cam.center || [0, 0];
        out.scale = lerp(cam.from != null ? cam.from : 1, cam.to != null ? cam.to : 1.08, e);
        out.dx = cx * w; out.dy = cy * h;
        break;
      }
      case 'handheld': {
        const amp = cam.amp != null ? cam.amp : 5;         // 像素（1080p 基准）
        const freq = cam.freq != null ? cam.freq : 1.6;    // 抖动速度
        const seed = cam.seed != null ? cam.seed : 7;
        const k = (h / 1080) || 1;                          // 跟着分辨率放大，4K 不会变成微抖
        out.dx = noise(seed, t * freq) * amp * k;
        out.dy = noise(seed + 31, t * freq) * amp * k * 0.8;
        out.rot = noise(seed + 71, t * freq) * (cam.rotAmp != null ? cam.rotAmp : 0.0016);
        break;
      }
      case 'shake': {
        // 撞击 / 强调用的衰减震动：一起一落，衰减到 0（不是持续抖）
        const amp = cam.amp != null ? cam.amp : 14;
        const freq = cam.freq != null ? cam.freq : 3.4;
        const decay = cam.decay != null ? cam.decay : 5;
        const seed = cam.seed != null ? cam.seed : 3;
        const env = Math.exp(-decay * Math.max(0, t - (cam.t0 || 0)));
        const k = (h / 1080) || 1;
        out.dx = noise(seed, t * freq * 2.2) * amp * env * k;
        out.dy = noise(seed + 17, t * freq * 2.2) * amp * env * k;
        break;
      }
      case 'static':
      default:
        break;
    }
    return out;
  }

  /** 多个运镜叠加（顺序无关，逐项累加；scale 相乘） */
  function stack(cams, t, W, H) {
    const out = { dx: 0, dy: 0, scale: 1, rot: 0 };
    for (const c of cams || []) {
      const r = at(c, t, W, H);
      out.dx += r.dx; out.dy += r.dy; out.scale *= r.scale; out.rot += r.rot;
    }
    return out;
  }

  /** 套用变换：画内容之前调用，之后必须 pop */
  function push(g, tr, W, H) {
    g.save();
    if (!tr) return;
    g.translate(W / 2 + (tr.dx || 0), H / 2 + (tr.dy || 0));
    if (tr.rot) g.rotate(tr.rot);
    if (tr.scale && tr.scale !== 1) g.scale(tr.scale, tr.scale);
    g.translate(-W / 2, -H / 2);
  }

  function pop(g) { g.restore(); }

  /**
   * 一次性包裹：CAM.with(g, tr, W, H, () => { ...画内容... })
   * 忘了 pop 会让后续所有帧不断叠加变换 —— 用这个写法不会忘。
   */
  function withCam(g, tr, W, H, fn) { push(g, tr, W, H); try { fn(); } finally { pop(g); } }

  /** 推拉镜头（Ken Burns）的快捷构造 */
  function kenburns(opts) {
    return Object.assign({ kind: 'kenburns', from: [0.02, -0.01, 1.0], to: [-0.03, 0.015, 1.09], dur: 6 }, opts || {});
  }

  /**
   * 呼吸：极轻的持续缩放，专门治「画面死了」。
   * loop = 一个完整来回的秒数（默认 4.2s 去、4.2s 回）；
   * 幅度 1.4% 是经验值 —— 再大就看出「在缩放」而不是「在呼吸」。
   */
  function breath(opts) {
    return Object.assign({
      kind: 'zoom', from: 1.0, to: 1.014, dur: 4.2, loop: 4.2,
      ease: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
    }, opts || {});
  }

  const CAM = { at, stack, push, pop, withCam, noise, kenburns, breath, IDENTITY, clamp, lerp };

  root.CAM = CAM;
  if (typeof module === 'object' && module.exports) module.exports = CAM;
})(typeof globalThis !== 'undefined' ? globalThis : this);

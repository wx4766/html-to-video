/**
 * 图形元件库 SH —— 图标、卡片、箭头、连接线、背景纹理。
 *
 * 为什么是「代码画的元件」而不是预置图片素材：
 *   1. 零外部依赖、零版权风险 —— 全是自写的 path 数据，没有一张外部图
 *   2. 风格必然统一 —— 同一套线宽 / 圆角 / 描边端点，和主题调色板联动
 *   3. 任意分辨率都清晰 —— 矢量，4K 不糊
 *   4. 体积为零 —— 没有 assets 目录要下载
 *
 * 这也是本项目刻意**不做**「卡通人物位图包 / 标志性建筑照片包」的原因：
 * 照片类素材一是版权说不清，二是风格会和用户自己的画面打架，三是把仓库撑大几十 MB
 * 却只有少数人用得上。要人物请走 assets/lib/figures.js（参数化的矢量人）。
 *
 * 用法：
 *   <script src="../lib/shapes.js"></script>
 *   SH.icon(g, 'bolt', x, y, 48, { color: TH.accent, width: 2.5 });
 *   SH.card(g, { x, y, w, h }, { fill: TH.panel, stroke: TH.faint, radius: 18 });
 *
 * 全部纯函数、无随机数（纹理噪声用固定种子的 LCG），同输入同输出。
 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const TAU = Math.PI * 2;

  /* ── 图标：24×24 网格里的路径指令 ──────────────────────────────────
     指令：M 移动 / L 直线 / C 二次曲线 / A 圆弧 / O 整圆 / R 圆角矩形 / Z 闭合
     全部是描边风格（线性图标），需要实心时传 fill。
     ──────────────────────────────────────────────────────────────── */
  const ICONS = {
    check:   [['M', 4, 12.5], ['L', 9, 17.5], ['L', 20, 6]],
    cross:   [['M', 6, 6], ['L', 18, 18], ['M', 18, 6], ['L', 6, 18]],
    plus:    [['M', 12, 5], ['L', 12, 19], ['M', 5, 12], ['L', 19, 12]],
    minus:   [['M', 5, 12], ['L', 19, 12]],
    arrowRight: [['M', 4, 12], ['L', 20, 12], ['M', 14, 6], ['L', 20, 12], ['L', 14, 18]],
    arrowLeft:  [['M', 20, 12], ['L', 4, 12], ['M', 10, 6], ['L', 4, 12], ['L', 10, 18]],
    arrowUp:    [['M', 12, 20], ['L', 12, 4], ['M', 6, 10], ['L', 12, 4], ['L', 18, 10]],
    arrowDown:  [['M', 12, 4], ['L', 12, 20], ['M', 6, 14], ['L', 12, 20], ['L', 18, 14]],
    chevronRight: [['M', 9, 5], ['L', 16, 12], ['L', 9, 19]],
    chevronDown:  [['M', 5, 9], ['L', 12, 16], ['L', 19, 9]],
    refresh: [['A', 12, 12, 8, Math.PI * 0.85, Math.PI * 2.15],
              ['M', 18.2, 3.4], ['L', 20.4, 5.6], ['L', 17.4, 7.4]],
    star:    [['M', 12, 3], ['L', 14.7, 9.2], ['L', 21.5, 9.9], ['L', 16.4, 14.4],
              ['L', 17.8, 21], ['L', 12, 17.6], ['L', 6.2, 21], ['L', 7.6, 14.4],
              ['L', 2.5, 9.9], ['L', 9.3, 9.2], ['Z']],
    heart:   [['M', 12, 20.3], ['C', 3, 14.5, 3, 8.6, 7.5, 8.6],
              ['C', 9.6, 8.6, 11, 10.1, 12, 11.5], ['C', 13, 10.1, 14.4, 8.6, 16.5, 8.6],
              ['C', 21, 8.6, 21, 14.5, 12, 20.3], ['Z']],
    bolt:    [['M', 13.5, 2.5], ['L', 5.5, 13.5], ['L', 11, 13.5], ['L', 9, 21.5],
              ['L', 18.5, 9.5], ['L', 12.8, 9.5], ['Z']],
    cloud:   [['M', 7.2, 18.4], ['A', 7.4, 16.6, 3.8, Math.PI * 0.72, Math.PI * 1.62],
              ['A', 13.4, 13.6, 5.4, Math.PI * 1.32, Math.PI * 0.12],
              ['A', 18.6, 17.2, 3.4, Math.PI * 1.52, Math.PI * 0.42]],
    code:    [['M', 8.5, 6], ['L', 3.5, 12], ['L', 8.5, 18], ['M', 15.5, 6], ['L', 20.5, 12], ['L', 15.5, 18]],
    /* 圆柱体：顶面是扁椭圆，不是整圆 —— 整圆会画成一颗药丸 */
    database: [['E', 12, 6.4, 7.2, 2.6],
               ['M', 4.8, 6.4], ['L', 4.8, 17.8],
               ['M', 19.2, 6.4], ['L', 19.2, 17.8],
               ['A', 12, 17.8, 7.2, 0, Math.PI],
               ['A', 12, 11.9, 7.2, 0, Math.PI]],
    server:  [['R', 3.2, 3.6, 17.6, 6.4, 1.8], ['R', 3.2, 14, 17.6, 6.4, 1.8],
              ['M', 6.6, 6.8], ['L', 6.6, 6.8], ['M', 6.6, 17.2], ['L', 6.6, 17.2]],
    lock:    [['R', 4.5, 10.5, 15, 9.5, 2.4], ['A', 12, 10.5, 5, Math.PI, TAU], ['M', 12, 14], ['L', 12, 16.8]],
    shield:  [['M', 12, 3], ['L', 20, 6], ['L', 20, 12], ['C', 20, 16.8, 16.4, 20.2, 12, 21.4],
              ['C', 7.6, 20.2, 4, 16.8, 4, 12], ['L', 4, 6], ['Z']],
    rocket:  [['M', 12, 2.6], ['C', 16.6, 6, 18, 10.4, 18, 14.6], ['L', 15.4, 18.6],
              ['L', 8.6, 18.6], ['L', 6, 14.6], ['C', 6, 10.4, 7.4, 6, 12, 2.6], ['Z'],
              ['O', 12, 9.4, 2.4], ['M', 8.6, 18.6], ['L', 6.4, 21.4], ['M', 15.4, 18.6], ['L', 17.6, 21.4]],
    bulb:    [['A', 12, 10, 6.4, Math.PI * 0.82, Math.PI * 0.18], ['L', 9.4, 17.6], ['L', 14.6, 17.6], ['Z'],
              ['M', 9.8, 20.4], ['L', 14.2, 20.4]],
    clock:   [['O', 12, 12, 8.6], ['M', 12, 6.6], ['L', 12, 12], ['L', 16, 14]],
    calendar: [['R', 3.4, 5, 17.2, 15.6, 2.4], ['M', 3.4, 9.6], ['L', 20.6, 9.6],
               ['M', 8, 3], ['L', 8, 6.6], ['M', 16, 3], ['L', 16, 6.6]],
    chart:   [['M', 5, 20], ['L', 19, 20], ['M', 8, 20], ['L', 8, 12], ['M', 12.5, 20], ['L', 12.5, 6.5],
              ['M', 17, 20], ['L', 17, 15]],
    trend:   [['M', 3.5, 17.5], ['L', 9, 11.5], ['L', 13.5, 15], ['L', 20.5, 6.5],
              ['M', 16, 6.5], ['L', 20.5, 6.5], ['L', 20.5, 11]],
    pie:     [['O', 12, 12, 8.6], ['M', 12, 12], ['L', 12, 3.4], ['A', 12, 12, 8.6, -Math.PI / 2, Math.PI * 0.35], ['Z']],
    mail:    [['R', 2.8, 5.4, 18.4, 13.2, 2.2], ['M', 3.4, 6.6], ['L', 12, 13.2], ['L', 20.6, 6.6]],
    phone:   [['R', 6.6, 2.6, 10.8, 18.8, 2.6], ['M', 10.2, 18.6], ['L', 13.8, 18.6]],
    user:    [['O', 12, 8, 4.2], ['A', 12, 22, 8.2, Math.PI * 1.22, Math.PI * 1.78]],
    users:   [['O', 9, 8.4, 3.4], ['A', 9, 21.6, 6.6, Math.PI * 1.28, Math.PI * 1.72],
              ['M', 15.4, 5.6], ['A', 18.4, 8.4, 3, Math.PI * 1.1, Math.PI * 1.9],
              ['A', 18.4, 21.4, 5.6, Math.PI * 1.32, Math.PI * 1.68]],
    play:    [['M', 8, 5.4], ['L', 18.4, 12], ['L', 8, 18.6], ['Z']],
    pause:   [['M', 8.6, 5.6], ['L', 8.6, 18.4], ['M', 15.4, 5.6], ['L', 15.4, 18.4]],
    download: [['M', 12, 3.6], ['L', 12, 14.6], ['M', 7, 10.2], ['L', 12, 15.2], ['L', 17, 10.2],
               ['M', 4.4, 18.6], ['L', 19.6, 18.6]],
    upload:  [['M', 12, 15.2], ['L', 12, 4.2], ['M', 7, 8.6], ['L', 12, 3.6], ['L', 17, 8.6],
              ['M', 4.4, 18.6], ['L', 19.6, 18.6]],
    search:  [['O', 10.6, 10.6, 6.4], ['M', 15.4, 15.4], ['L', 20.2, 20.2]],
    filter:  [['M', 3.6, 5.6], ['L', 20.4, 5.6], ['M', 6.4, 12], ['L', 17.6, 12],
              ['M', 9.6, 18.4], ['L', 14.4, 18.4]],
    trash:   [['M', 4.4, 6.6], ['L', 19.6, 6.6], ['M', 9.4, 6.6], ['L', 9.4, 3.6], ['M', 14.6, 6.6], ['L', 14.6, 3.6],
              ['R', 6, 6.6, 12, 13.8, 1.8], ['M', 10, 10.4], ['L', 10, 16.6], ['M', 14, 10.4], ['L', 14, 16.6]],
    edit:    [['M', 4, 20], ['L', 4, 15.6], ['L', 16.4, 3.2], ['L', 20.8, 7.6], ['L', 8.4, 20], ['Z'],
              ['M', 14.6, 5], ['L', 19, 9.4]],
    link:    [['A', 9.4, 12, 4.6, Math.PI * 0.62, Math.PI * 1.38], ['A', 14.6, 12, 4.6, Math.PI * 1.62, Math.PI * 0.38],
              ['M', 9.6, 9.6], ['L', 14.4, 14.4]],
    globe:   [['O', 12, 12, 8.6], ['A', 12, 12, 4.2, 0, Math.PI],
              ['M', 3.4, 12], ['L', 20.6, 12], ['M', 12, 3.4], ['A', 12, 12, 8.6, -Math.PI / 2, Math.PI / 2]],
    wifi:    [['A', 12, 18, 2.2, Math.PI * 0.75, Math.PI * 2.25],
              ['A', 12, 18, 6, Math.PI * 0.85, Math.PI * 2.15],
              ['A', 12, 18, 9.8, Math.PI * 0.9, Math.PI * 2.1]],
    battery: [['R', 2.6, 7.4, 16.4, 9.2, 2], ['M', 20.6, 10.2], ['L', 20.6, 13.8], ['R', 4.6, 9.4, 8, 5.2, 1]],
    camera:  [['R', 2.8, 6.6, 18.4, 12.4, 2.4], ['O', 12, 12.8, 3.6], ['M', 8, 6.6], ['L', 9.6, 4.4], ['L', 14.4, 4.4]],
    mic:     [['R', 9, 3, 6, 10.4, 3], ['A', 12, 14.6, 5.4, Math.PI, TAU], ['M', 12, 17.6], ['L', 12, 20.6],
              ['M', 8, 20.6], ['L', 16, 20.6]],
    image:   [['R', 3, 4.6, 18, 14.8, 2.2], ['O', 8.4, 9.2, 1.8],
              ['M', 4.2, 17.4], ['L', 9.6, 12], ['L', 13.8, 15.6], ['L', 17, 13.2], ['L', 19.8, 15.8]],
    folder:  [['M', 3, 6.4], ['L', 9.4, 6.4], ['L', 11.4, 9], ['L', 21, 9], ['L', 21, 19], ['L', 3, 19], ['Z']],
    file:    [['M', 6, 3.4], ['L', 13.4, 3.4], ['L', 18, 8], ['L', 18, 20.6], ['L', 6, 20.6], ['Z'],
              ['M', 13.2, 3.6], ['L', 13.2, 8.2], ['L', 17.8, 8.2]],
    tag:     [['M', 3.6, 11.4], ['L', 11.4, 3.6], ['L', 20.4, 3.6], ['L', 20.4, 12.6], ['L', 12.6, 20.4], ['Z'],
              ['O', 16.4, 8, 1.8]],
    flag:    [['M', 5.4, 3.4], ['L', 5.4, 20.6], ['M', 5.4, 4.6], ['L', 18.6, 8.4], ['L', 13.4, 12.8], ['L', 18.6, 17], ['L', 5.4, 17]],
    home:    [['M', 3.4, 11], ['L', 12, 3.6], ['L', 20.6, 11], ['R', 5.6, 11, 12.8, 9.4, 1.6], ['R', 9.8, 14.6, 4.4, 5.8, 1]],
    chat:    [['M', 3.6, 5.4], ['L', 20.4, 5.4], ['L', 20.4, 16.4], ['L', 13.6, 16.4], ['L', 9, 20.6], ['L', 9, 16.4],
              ['L', 3.6, 16.4], ['Z']],
    bell:    [['A', 12, 15.4, 5.6, Math.PI, TAU], ['M', 6.4, 15.4], ['L', 4.6, 18.6], ['L', 19.4, 18.6], ['L', 17.6, 15.4],
              ['A', 12, 5.6, 2.2, Math.PI, TAU], ['M', 10.4, 20.8], ['A', 12, 20.4, 1.6, Math.PI * 0.15, Math.PI * 0.85]],
    eye:     [['A', 12, 12, 8.4, Math.PI * 1.18, Math.PI * 1.82], ['A', 12, 12, 8.4, Math.PI * 0.18, Math.PI * 0.82],
              ['O', 12, 12, 2.8]],
    fire:    [['M', 12, 2.6], ['C', 16.4, 6.4, 18.6, 10.4, 17.4, 14.6], ['C', 19, 17.6, 19.4, 20.4, 17.6, 21.4],
              ['C', 10, 21.4, 4.6, 19, 4.6, 15], ['C', 4.6, 11.4, 7.4, 8.6, 12, 2.6], ['Z']],
    leaf:    [['M', 4.6, 19.4], ['C', 4.6, 10.4, 9.6, 4.6, 19.4, 4.6], ['C', 19.4, 13.6, 13.6, 19.4, 4.6, 19.4], ['Z'],
              ['M', 6.6, 17.4], ['L', 15.4, 8.6]],
    target:  [['O', 12, 12, 8.6], ['O', 12, 12, 4.8], ['O', 12, 12, 1.4]],
    trophy:  [['M', 7.4, 3.6], ['L', 16.6, 3.6], ['L', 16.6, 8], ['A', 12, 12.6, 5.4, Math.PI * 0.2, Math.PI * 0.8],
              ['L', 16.6, 8], ['M', 12, 12.6], ['L', 12, 17], ['M', 8.4, 20.4], ['L', 15.6, 20.4],
              ['M', 16.6, 4.6], ['L', 20, 6.4], ['M', 7.4, 4.6], ['L', 4, 6.4]],
    cpu:     [['R', 6.4, 6.4, 11.2, 11.2, 1.6], ['R', 9.6, 9.6, 4.8, 4.8, 1],
              ['M', 9.6, 3], ['L', 9.6, 6.4], ['M', 14.4, 3], ['L', 14.4, 6.4],
              ['M', 9.6, 17.6], ['L', 9.6, 21], ['M', 14.4, 17.6], ['L', 14.4, 21],
              ['M', 3, 9.6], ['L', 6.4, 9.6], ['M', 3, 14.4], ['L', 6.4, 14.4],
              ['M', 17.6, 9.6], ['L', 21, 9.6], ['M', 17.6, 14.4], ['L', 21, 14.4]],
    robot:   [['R', 4.4, 7.4, 15.2, 10.6, 2.6], ['M', 12, 7.4], ['L', 12, 4], ['O', 12, 3, 1.4],
              ['O', 9, 12.4, 1.4], ['O', 15, 12.4, 1.4], ['M', 9.4, 15.4], ['L', 14.6, 15.4],
              ['M', 7, 18], ['L', 7, 20.6], ['M', 17, 18], ['L', 17, 20.6]],
    layers:  [['M', 12, 3.4], ['L', 21, 8], ['L', 12, 12.6], ['L', 3, 8], ['Z'],
              ['M', 3, 12.4], ['L', 12, 16.8], ['L', 21, 12.4], ['M', 3, 16.6], ['L', 12, 21], ['L', 21, 16.6]],
    pin:     [['A', 12, 9.6, 6.2, Math.PI * 0.86, Math.PI * 0.14], ['L', 12, 20.8], ['Z'], ['O', 12, 9.4, 2.4]],
    brush:   [['M', 4, 20], ['L', 9.4, 14.6], ['M', 12.6, 4.6], ['L', 19.4, 11.4],
              ['M', 15.6, 7.6], ['L', 8.8, 14.4], ['M', 9.4, 14.6], ['L', 6, 18], ['L', 4, 20]],
    book:    [['M', 4, 4.6], ['L', 10.4, 4.6], ['A', 12, 6.4, 2.6, Math.PI, TAU], ['L', 20, 4.6], ['L', 20, 19.4],
              ['L', 12, 19.4], ['L', 10.4, 18], ['L', 4, 18], ['Z'], ['M', 12, 6.4], ['L', 12, 19.4]],
    wand:    [['M', 4.6, 19.4], ['L', 14, 10], ['M', 16.6, 3.4], ['L', 20.6, 7.4], ['M', 17.4, 12.6], ['L', 19.4, 14.6],
              ['M', 20, 3], ['L', 20, 7], ['M', 18, 5], ['L', 22, 5]],
    cart:    [['M', 3, 4.6], ['L', 6.4, 4.6], ['L', 9, 15.4], ['L', 19, 15.4], ['L', 21, 7.4], ['L', 6.4, 7.4],
              ['O', 10.4, 19, 1.6], ['O', 16.8, 19, 1.6]],
    money:   [['O', 12, 12, 8.6], ['M', 8.6, 8], ['L', 12, 12], ['L', 15.4, 8],
              ['M', 12, 12], ['L', 12, 17], ['M', 9, 13.4], ['L', 15, 13.4], ['M', 9, 15.6], ['L', 15, 15.6]],
    gift:    [['R', 3.4, 8.4, 17.2, 4, 1.4], ['R', 4.6, 12.4, 14.8, 8.2, 1.4],
              ['M', 12, 8.4], ['L', 12, 20.6], ['M', 12, 8.4], ['C', 12, 4.4, 8.4, 4.4, 8.6, 6.6],
              ['M', 12, 8.4], ['C', 12, 4.4, 15.6, 4.4, 15.4, 6.6]],
    gear:    null,   // 下面用生成器补（环 + 八根辐条）
  };

  /* 齿轮：环 + 八根辐条，程序化生成比手写 16 组坐标可靠 */
  (function buildGear() {
    const ops = [['O', 12, 12, 3.6]];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      ops.push(['M', 12 + c * 5.4, 12 + s * 5.4]);
      ops.push(['L', 12 + c * 8.8, 12 + s * 8.8]);
    }
    ops.push(['O', 12, 12, 9.2]);
    ICONS.gear = ops;
  })();

  /** 画图标。x/y 是左上角，size 是边长（图标按 24 网格等比缩放） */
  function icon(g, name, x, y, size, o = {}) {
    const ops = ICONS[name];
    if (!ops) return false;
    const s = (size || 24) / 24;
    g.save();
    g.translate(x, y);
    g.scale(s, s);
    g.beginPath();
    for (const op of ops) {
      switch (op[0]) {
        case 'M': g.moveTo(op[1], op[2]); break;
        case 'L': g.lineTo(op[1], op[2]); break;
        case 'C': g.quadraticCurveTo(op[1], op[2], op[3], op[4]); break;
        case 'A': {
          // 先 moveTo 到弧起点，否则 arc 会从当前点拉一条直线过去
          const a0 = op[4], a1 = op[5];
          g.moveTo(op[1] + op[3] * Math.cos(a0), op[2] + op[3] * Math.sin(a0));
          g.arc(op[1], op[2], op[3], a0, a1, !!op[6]);
          break;
        }
        case 'O': g.moveTo(op[1] + op[3], op[2]); g.arc(op[1], op[2], op[3], 0, TAU); break;
        /* E = 椭圆（cx, cy, rx, ry）：数据库 / 圆盘这类图标必须是扁椭圆，
           用整圆会画成一根「胶囊」。 */
        case 'E': g.moveTo(op[1] + op[3], op[2]); g.ellipse(op[1], op[2], op[3], op[4], 0, 0, TAU); break;
        case 'R': rrPath(g, op[1], op[2], op[3], op[4], op[5]); break;
        case 'Z': g.closePath(); break;
        default: break;
      }
    }
    // 线宽在缩放之后设，所以这里的除法让最终线宽等于传入的像素值
    g.lineWidth = (o.width != null ? o.width : 2) / s;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (o.fill) { g.fillStyle = o.fill; g.fill(); }
    if (o.color) { g.strokeStyle = o.color; g.stroke(); }
    g.restore();
    return true;
  }

  function iconNames() { return Object.keys(ICONS).sort(); }
  function hasIcon(name) { return !!ICONS[name]; }

  /* ── 基础几何 ─────────────────────────────────────────────────── */

  function rrPath(g, x, y, w, h, r) {
    const rr = Math.min(r == null ? 0 : r, Math.abs(w) / 2, Math.abs(h) / 2);
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  function roundRect(g, x, y, w, h, r) { g.beginPath(); rrPath(g, x, y, w, h, r); }

  /** 卡片：底板 + 描边 + 可选柔光阴影 */
  function card(g, box, o = {}) {
    const r = o.radius != null ? o.radius : 16;
    g.save();
    if (o.shadow) {
      g.shadowColor = o.shadow;
      g.shadowBlur = o.shadowBlur != null ? o.shadowBlur : 28;
      g.shadowOffsetY = o.shadowY != null ? o.shadowY : 8;
    }
    roundRect(g, box.x, box.y, box.w, box.h, r);
    if (o.fill) { g.fillStyle = o.fill; g.fill(); }
    g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
    if (o.stroke) { g.strokeStyle = o.stroke; g.lineWidth = o.width != null ? o.width : 1.2; g.stroke(); }
    g.restore();
  }

  /** 胶囊（标签底） */
  function pill(g, x, y, w, h, fill) {
    roundRect(g, x, y, w, h, h / 2);
    g.fillStyle = fill;
    g.fill();
  }

  /** 箭头：直线 + 箭头（可选 curve 给一个控制点做弯箭头） */
  function arrow(g, x1, y1, x2, y2, o = {}) {
    const w = o.width != null ? o.width : 2;
    const head = o.head != null ? o.head : w * 4;
    const ang = Math.atan2(y2 - y1, x2 - x1);
    g.save();
    g.strokeStyle = o.color || '#fff';
    g.fillStyle = o.color || '#fff';
    g.lineWidth = w;
    g.lineCap = 'round';
    g.beginPath();
    if (o.curve) { g.moveTo(x1, y1); g.quadraticCurveTo(o.curve[0], o.curve[1], x2, y2); }
    else { g.moveTo(x1, y1); g.lineTo(x2, y2); }
    g.stroke();
    // 箭头方向取终点处的切线（弯箭头才不会指歪）
    const tipAng = o.curve ? Math.atan2(y2 - o.curve[1], x2 - o.curve[0]) : ang;
    const a = tipAng;
    g.beginPath();
    g.moveTo(x2, y2);
    g.lineTo(x2 - head * Math.cos(a - 0.42), y2 - head * Math.sin(a - 0.42));
    g.lineTo(x2 - head * Math.cos(a + 0.42), y2 - head * Math.sin(a + 0.42));
    g.closePath();
    g.fill();
    g.restore();
  }

  /** 正交折线连接（流程图里两个方块之间的走线） */
  function elbow(g, pts, o = {}) {
    if (!pts || pts.length < 2) return;
    g.save();
    g.strokeStyle = o.color || '#fff';
    g.lineWidth = o.width != null ? o.width : 2;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (o.dash) g.setLineDash(o.dash);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1];
      const [cx, cy] = pts[i];
      if (o.axis === 'y') { g.lineTo(px, (py + cy) / 2); g.lineTo(cx, (py + cy) / 2); }
      else { g.lineTo((px + cx) / 2, py); g.lineTo((px + cx) / 2, cy); }
      g.lineTo(cx, cy);
    }
    g.stroke();
    g.restore();
  }

  function dashRect(g, x, y, w, h, o = {}) {
    g.save();
    g.setLineDash(o.dash || [8, 6]);
    g.strokeStyle = o.color || '#fff';
    g.lineWidth = o.width != null ? o.width : 1.4;
    roundRect(g, x, y, w, h, o.radius != null ? o.radius : 8);
    g.stroke();
    g.restore();
  }

  /** 进度弧（圆环进度） */
  function progressArc(g, cx, cy, r, p, o = {}) {
    const a0 = o.from != null ? o.from : -Math.PI / 2;
    g.save();
    g.lineCap = 'round';
    g.lineWidth = o.width != null ? o.width : 6;
    if (o.track) {
      g.strokeStyle = o.track;
      g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.stroke();
    }
    g.strokeStyle = o.color || '#fff';
    g.beginPath();
    g.arc(cx, cy, r, a0, a0 + TAU * clamp(p));
    g.stroke();
    g.restore();
  }

  /* ── 背景与纹理 ───────────────────────────────────────────────── */

  function grid(g, W, H, o = {}) {
    const step = o.step || 80;
    g.save();
    g.strokeStyle = o.color || 'rgba(255,255,255,.06)';
    g.globalAlpha = o.alpha != null ? o.alpha : 1;
    g.lineWidth = o.width != null ? o.width : 1;
    g.beginPath();
    for (let x = (o.offsetX || 0) % step; x < W; x += step) { g.moveTo(x, 0); g.lineTo(x, H); }
    for (let y = (o.offsetY || 0) % step; y < H; y += step) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    g.restore();
  }

  function dots(g, W, H, o = {}) {
    const step = o.step || 44, r = o.r != null ? o.r : 1.2;
    g.save();
    g.fillStyle = o.color || 'rgba(255,255,255,.08)';
    g.globalAlpha = o.alpha != null ? o.alpha : 1;
    for (let y = step / 2; y < H; y += step) {
      for (let x = step / 2; x < W; x += step) {
        g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
    }
    g.restore();
  }

  /** 柔光斑（给平背景一点层次，别叠在文字上） */
  function glow(g, x, y, r, color, alpha) {
    const grd = g.createRadialGradient(x, y, 0, x, y, Math.max(1, r));
    grd.addColorStop(0, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.save();
    g.globalAlpha = alpha != null ? alpha : 1;
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, Math.max(1, r), 0, TAU); g.fill();
    g.restore();
  }

  /** 暗角：把注意力收回到中间 */
  function vignette(g, W, H, strength = 0.45, color = '#000') {
    const grd = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, color);
    g.save();
    g.globalAlpha = strength;
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    g.restore();
  }

  /** 极光 / 网格流动背景：靠 sin 驱动，确定性，不需要噪点图 */
  function mesh(g, W, H, colors, t, o = {}) {
    const n = colors.length;
    g.save();
    g.globalCompositeOperation = o.composite || 'lighter';
    for (let i = 0; i < n; i++) {
      const px = W * (0.5 + 0.34 * Math.sin(t * 0.11 + i * 2.1));
      const py = H * (0.5 + 0.30 * Math.cos(t * 0.13 + i * 1.7));
      glow(g, px, py, Math.max(W, H) * (o.radius != null ? o.radius : 0.46), colors[i], (o.alpha != null ? o.alpha : 0.20));
    }
    g.restore();
  }

  /* 颗粒噪点：固定种子生成一次，之后当 pattern 用。
     用固定 LCG 是为了「确定性」—— 换 worker、重渲都是同一张噪点。 */
  const _grainCache = new Map();
  function grainPattern(g, seed = 7, size = 128) {
    const key = seed + ':' + size;
    let pat = _grainCache.get(key);
    if (!pat) {
      if (typeof document === 'undefined') return null;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const cg = c.getContext('2d');
      const img = cg.createImageData(size, size);
      let s = (seed * 1103515245 + 12345) >>> 0;
      for (let i = 0; i < img.data.length; i += 4) {
        s = (s * 1103515245 + 12345) >>> 0;          // LCG：同种子必得同序列
        const v = (s >>> 24) & 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      cg.putImageData(img, 0, 0);
      pat = g.createPattern(c, 'repeat');
      if (pat) _grainCache.set(key, pat);
    }
    return pat;
  }

  /** 铺一层胶片颗粒（alpha 建议 0.03–0.06，多了就脏） */
  function grain(g, W, H, alpha = 0.04, seed = 7) {
    const pat = grainPattern(g, seed);
    if (!pat) return;
    g.save();
    g.globalAlpha = alpha;
    g.globalCompositeOperation = 'overlay';
    g.fillStyle = pat;
    g.fillRect(0, 0, W, H);
    g.restore();
  }

  /** 取景框四角（科技感装饰，也用来框住重点区域） */
  function corners(g, box, o = {}) {
    const len = o.len != null ? o.len : 26;
    const w = o.width != null ? o.width : 2.5;
    g.save();
    g.strokeStyle = o.color || '#fff';
    g.lineWidth = w;
    g.lineCap = 'round';
    const { x, y, w: bw, h: bh } = box;
    const seg = [
      [[x, y + len], [x, y], [x + len, y]],
      [[x + bw - len, y], [x + bw, y], [x + bw, y + len]],
      [[x + bw, y + bh - len], [x + bw, y + bh], [x + bw - len, y + bh]],
      [[x + len, y + bh], [x, y + bh], [x, y + bh - len]],
    ];
    for (const s of seg) {
      g.beginPath();
      g.moveTo(s[0][0], s[0][1]);
      for (let i = 1; i < s.length; i++) g.lineTo(s[i][0], s[i][1]);
      g.stroke();
    }
    g.restore();
  }

  /** 线性渐变快捷方式 */
  function grad(g, x0, y0, x1, y1, stops) {
    const grd = g.createLinearGradient(x0, y0, x1, y1);
    for (const [p, c] of stops) grd.addColorStop(p, c);
    return grd;
  }

  /** 分隔线（左右渐隐，比实心线轻） */
  function sepLine(g, x, y, w, o = {}) {
    const grd = grad(g, x, y, x + w, y, [[0, 'rgba(255,255,255,0)'], [0.5, o.color || 'rgba(255,255,255,.28)'], [1, 'rgba(255,255,255,0)']]);
    g.save();
    g.fillStyle = grd;
    g.fillRect(x, y, w, o.width != null ? o.width : 1);
    g.restore();
  }

  const SH = {
    ICONS, icon, iconNames, hasIcon,
    roundRect, rrPath, card, pill, arrow, elbow, dashRect, progressArc,
    grid, dots, glow, vignette, mesh, grain, corners, grad, sepLine,
    clamp,
  };

  root.SH = SH;
  if (typeof module === 'object' && module.exports) module.exports = SH;
})(typeof globalThis !== 'undefined' ? globalThis : this);

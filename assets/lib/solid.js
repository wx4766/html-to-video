/**
 * solid.js —— 实体与着色（v2.1）
 *
 * ┌ 为什么要有这一层 ──────────────────────────────────────────────
 * │ v2.0 的 space.js 只有 billboard：「贴在空间里的平面片」。
 * │ 平面片没有法线，所以不能着色；没有侧面，所以不能转；
 * │ 没有曲面，所以做不出细胞、礁石、灯泡、灯塔。
 * │ 结果就是——镜头在动，画面还是平的。观众一眼看出是「卡片拼的」。
 * │
 * │ 这一层补的是那件事：**面**。
 * │   · 顶点 + 四边形/三角面 + 面法线
 * │   · Lambert 漫反射 + Blinn-Phong 高光 + 边缘光 + 天光梯度
 * │   · 画家算法排序（远面先画）+ 近裁剪
 * │   · 几何生成器：box / lathe（旋转体）/ sphere / tube（扫掠）/ terrain（高度场）
 * │
 * │ 不是 3D 引擎：没有 z-buffer、没有阴影贴图、没有 PBR。
 * │ 但「一个球被侧光照亮、暗面偏冷、边缘有一道亮线」
 * │ 这件事已经足够让画面从「贴纸」变成「实体」。
 * └──────────────────────────────────────────────────────────────
 *
 * 坐标：沿用 space.js —— x 右、y 下、z 远。
 *
 * 用法：
 *   const m = SD.lathe([[0,0],[40,0],[26,-260],[12,-300]], 24, {color:[210,86,64]});
 *   const L = SD.light(LT.sky('dusk'), { dir:[-0.5,-0.7,0.5] });
 *   SD.draw(g, cam, [m], L);
 */
(function (root) {
  'use strict';

  const SP = root.SP || (typeof require === 'function' ? require('./space.js') : null);

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ── 几何容器 ────────────────────────────────────────────────────
     顶点用三支 Float64Array 平铺存（不存对象，省 GC）。
     面用四个 Int32Array：fa/fb/fc/fd，fd = -1 表示三角形。
     法线与中心在 build 时算一次，之后每帧只做投影与排序。 */
  function Mesh(nv, nf) {
    this.nv = nv; this.nf = nf;
    this.vx = new Float64Array(nv); this.vy = new Float64Array(nv); this.vz = new Float64Array(nv);
    this.fa = new Int32Array(nf); this.fb = new Int32Array(nf);
    this.fc = new Int32Array(nf); this.fd = new Int32Array(nf);
    this.nx = new Float64Array(nf); this.ny = new Float64Array(nf); this.nz = new Float64Array(nf);
    this.cx = new Float64Array(nf); this.cy = new Float64Array(nf); this.cz = new Float64Array(nf);
    this.skip = new Uint8Array(nf);  // 退化面（零面积）标记
    this.bump = 0;                   // 表面粗糙度（法线扰动强度）
    /* 逐面取色：岩石分层、地形高度渐变、金属污渍都靠它。
       不给就是整块单色 —— 单色是「模型感」最强的来源之一。 */
    this.colorBy = null;
    this.bn = null;                  // 每面随机相位
    this.col = [200, 200, 200];      // 基色 0–255
    this.mat = 'matte';              // matte | metal | glass | emissive | rock
    this.alpha = 1;
    this.cull = false;
    this.tag = '';
  }

  function build(mesh) {
    const { nv, nf, vx, vy, vz, fa, fb, fc, fd, nx, ny, nz, cx, cy, cz } = mesh;
    for (let i = 0; i < nf; i++) {
      const a = fa[i], b = fb[i], c = fc[i], d = fd[i];
      const ax = vx[a], ay = vy[a], az = vz[a];
      const bx = vx[b], by = vy[b], bz = vz[b];
      const qx = vx[c], qy = vy[c], qz = vz[c];
      /* 法线取前三个顶点。四边形若不共面，误差可接受（都是细分过的曲面）。 */
      let ux = bx - ax, uy = by - ay, uz = bz - az;
      let wx = qx - ax, wy = qy - ay, wz = qz - az;
      let Nx = uy * wz - uz * wy, Ny = uz * wx - ux * wz, Nz = ux * wy - uy * wx;
      const L = Math.hypot(Nx, Ny, Nz);
      if (!mesh.bn) {
        mesh.bn = new Float32Array(nf);
        for (let q = 0; q < nf; q++) {
          /* 三个不相关相位，做出「粗糙表面」的斑驳而非规则条纹 */
          mesh.bn[q] = Math.sin(q * 12.9898) * 43758.5453 % 1;
        }
      }
      /* 零面积面（旋转体极点、重合环）不画：不标记的话会画成一条毛刺线 */
      if (L < 1e-9) { mesh.skip[i] = 1; nx[i] = 0; ny[i] = 0; nz[i] = 1; }
      else { nx[i] = Nx / L; ny[i] = Ny / L; nz[i] = Nz / L; }
      /* 面中心（用全部顶点，四边形比三角更准） */
      if (d >= 0) {
        cx[i] = (ax + bx + qx + vx[d]) * 0.25;
        cy[i] = (ay + by + qy + vy[d]) * 0.25;
        cz[i] = (az + bz + qz + vz[d]) * 0.25;
      } else {
        cx[i] = (ax + bx + qx) / 3;
        cy[i] = (ay + by + qy) / 3;
        cz[i] = (az + bz + qz) / 3;
      }
    }
    mesh._built = true;
    return mesh;
  }

  /* ── 生成器 ──────────────────────────────────────────────────────
     全部返回 Mesh，坐标已是世界坐标（原点在物体中心或底部，见各注释）。 */

  /* 立方体：原点在中心。w 沿 x，h 沿 y，d 沿 z。 */
  function box(w, h, d, o) {
    o = o || {};
    const x = w / 2, y = h / 2, z = d / 2;
    const V = [
      [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
      [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
    ];
    /* 绕序必须让 cross(v1-v0, v2-v0) 指向**外侧**。
       写反了画面不会消失（draw 会把法线翻向相机），但背光面会被
       当成受光面 —— 于是出现「太阳从地下照上来」这种说不出哪里怪的图。
       改这六行之前先把每个面的叉乘手算一遍。 */
    const F = [
      [3, 2, 1, 0], [6, 7, 4, 5],   // 前(-z) 后(+z)
      [7, 3, 0, 4], [2, 6, 5, 1],   // 左(-x) 右(+x)
      [3, 2, 6, 7], [4, 5, 1, 0],   // 上(-y) 下(+y)
    ];
    return orient(fromFaces(V, F, o), () => [0, 0, 0]);
  }

  /* 旋转体：profile = [[r, y], ...]（从下往上），绕 y 轴转 seg 段。
     用途：灯塔、柱子、花瓶、灯泡、树干、蘑菇、细胞器。
     cap 为 true 时封底/封顶。 */
  function lathe(profile, seg, o) {
    o = o || {};
    seg = seg || 24;
    const P = profile.length;
    const V = [];
    for (let i = 0; i < P; i++) {
      const r = profile[i][0], y = profile[i][1];
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        V.push([Math.cos(a) * r, y, Math.sin(a) * r]);
      }
    }
    const F = [];
    for (let i = 0; i < P - 1; i++) {
      for (let s = 0; s < seg; s++) {
        const s2 = (s + 1) % seg;
        const a = i * seg + s, b = i * seg + s2;
        const c = (i + 1) * seg + s2, d = (i + 1) * seg + s;
        /* 半径为 0 的环退化成三角，跳过重复顶点 */
        if (profile[i][0] < 1e-6) F.push([a, c, d]);
        else if (profile[i + 1][0] < 1e-6) F.push([a, b, c]);
        else F.push([a, b, c, d]);
      }
    }
    if (o.cap !== false) {
      const base = V.length;
      V.push([0, profile[0][1], 0]);
      const top = V.length;
      V.push([0, profile[P - 1][1], 0]);
      for (let s = 0; s < seg; s++) {
        const s2 = (s + 1) % seg;
        F.push([base, s2, s]);
        F.push([top, (P - 1) * seg + s, (P - 1) * seg + s2]);
      }
    }
    return orient(fromFaces(V, F, o), (cx, cy) => [0, cy, 0]);
  }

  /* UV 球：原点在中心。ron 为横向段数，rings 为纵向圈数。 */
  function sphere(r, o) {
    o = o || {};
    const seg = o.seg || 24, rings = o.rings || 16;
    const V = [], F = [];
    for (let j = 0; j <= rings; j++) {
      const phi = (j / rings) * Math.PI;
      const y = -Math.cos(phi) * r;
      const rr = Math.sin(phi) * r;
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        V.push([Math.cos(a) * rr, y, Math.sin(a) * rr]);
      }
    }
    for (let j = 0; j < rings; j++) {
      for (let s = 0; s < seg; s++) {
        const s2 = (s + 1) % seg;
        const a = j * seg + s, b = j * seg + s2;
        const c = (j + 1) * seg + s2, d = (j + 1) * seg + s;
        if (j === 0) F.push([a, c, d]);
        else if (j === rings - 1) F.push([a, b, c]);
        else F.push([a, b, c, d]);
      }
    }
    return orient(fromFaces(V, F, o), () => [0, 0, 0]);
  }

  /* 扫掠管：沿 path（三维点列）生成圆管。用途：树干、栏杆、管道、血管、神经。
     半径可以是函数 r(t)。用平行传输算 frame，避免拐弯处扭麻花。 */
  function tube(path, radius, o) {
    o = o || {};
    const seg = o.seg || 10;
    const n = path.length;
    const V = [], F = [];
    let up = [0, 0, 1];
    let prevN = null;
    const frames = [];
    for (let i = 0; i < n; i++) {
      const p0 = path[Math.max(0, i - 1)], p1 = path[Math.min(n - 1, i + 1)];
      let t = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const tl = Math.hypot(t[0], t[1], t[2]) || 1;
      t = [t[0] / tl, t[1] / tl, t[2] / tl];
      let nn;
      if (!prevN) {
        /* 首个 frame：取与切线最不平行的轴 */
        const ax = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        nn = cross(t, ax);
      } else {
        /* 平行传输：用上一个法线投影到当前法平面 */
        const d = prevN[0] * t[0] + prevN[1] * t[1] + prevN[2] * t[2];
        nn = [prevN[0] - t[0] * d, prevN[1] - t[1] * d, prevN[2] - t[2] * d];
      }
      const nl = Math.hypot(nn[0], nn[1], nn[2]) || 1;
      nn = [nn[0] / nl, nn[1] / nl, nn[2] / nl];
      const bn = cross(t, nn);
      frames.push([nn, bn]);
      prevN = nn;
    }
    for (let i = 0; i < n; i++) {
      const p = path[i];
      const tv = n > 1 ? i / (n - 1) : 0;
      const r = typeof radius === 'function' ? radius(tv) : radius;
      const [nn, bn] = frames[i];
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
        V.push([
          p[0] + nn[0] * ca + bn[0] * sa,
          p[1] + nn[1] * ca + bn[1] * sa,
          p[2] + nn[2] * ca + bn[2] * sa,
        ]);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let s = 0; s < seg; s++) {
        const s2 = (s + 1) % seg;
        F.push([i * seg + s, i * seg + s2, (i + 1) * seg + s2, (i + 1) * seg + s]);
      }
    }
    const m = fromFaces(V, F, o);
    /* 每个面找最近的路径点当轴心，判断朝内还是朝外 */
    return orient(m, (cx, cy, cz) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < path.length; i++) {
        const d = (path[i][0] - cx) ** 2 + (path[i][1] - cy) ** 2 + (path[i][2] - cz) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return path[best];
    });
  }

  /* 高度场：nx × nz 网格铺在 xz 平面，hfn(u,v) 返回世界 y（向上为负）。
     用途：礁石、山地、沙丘、细胞膜起伏、纸浪。 */
  function terrain(nx, nz, w, d, hfn, o) {
    o = o || {};
    const V = [], F = [];
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const u = i / nx, v = j / nz;
        V.push([(u - 0.5) * w, hfn(u, v), (v - 0.5) * d]);
      }
    }
    const row = nx + 1;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * row + i, b = a + 1, c = a + row + 1, e = a + row;
        F.push([a, b, c, e]);
      }
    }
    const m = fromFaces(V, F, o);
    for (let i = 0; i < m.nf; i++) if (m.ny[i] > 0) flipFace(m, i);
    return build(m);
  }

  /* 平面片（仍按面处理，可受光；比 billboard 多了明暗） */
  function plane(w, h, o) {
    o = o || {};
    return fromFaces(
      [[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]],
      [[0, 1, 2, 3]], o
    );
  }

  /* 从顶点表 + 面表建 Mesh（生成器的公共出口） */
  function fromFaces(V, F, o) {
    const m = new Mesh(V.length, F.length);
    for (let i = 0; i < V.length; i++) {
      m.vx[i] = V[i][0]; m.vy[i] = V[i][1]; m.vz[i] = V[i][2];
    }
    for (let i = 0; i < F.length; i++) {
      const f = F[i];
      m.fa[i] = f[0]; m.fb[i] = f[1]; m.fc[i] = f[2]; m.fd[i] = f.length > 3 ? f[3] : -1;
    }
    o = o || {};
    if (o.color) m.col = o.color.slice(0, 3);
    if (o.mat) m.mat = o.mat;
    if (o.alpha != null) m.alpha = o.alpha;
    if (o.cull != null) m.cull = o.cull;
    if (o.tag) m.tag = o.tag;
    return build(m);
  }

  /* ── 法线朝向自校正 ──────────────────────────────────────────────
     手写绕序太容易错，而错了不会报错：只是背光面被当成受光面，
     太阳从地下照上来。这里用「面中心相对轴心」的几何关系自动翻转。
     凸体（box/sphere/lathe）与高度场（terrain）都能用。 */
  function flipFace(m, i) {
    if (m.fd[i] >= 0) { const t = m.fb[i]; m.fb[i] = m.fd[i]; m.fd[i] = t; }
    else { const t = m.fb[i]; m.fb[i] = m.fc[i]; m.fc[i] = t; }
  }

  /* axis(cx,cy,cz) 返回该面「应该朝外」的参考内点 */
  function orient(mesh, axis) {
    for (let i = 0; i < mesh.nf; i++) {
      const a = axis(mesh.cx[i], mesh.cy[i], mesh.cz[i]);
      const dx = mesh.cx[i] - a[0], dy = mesh.cy[i] - a[1], dz = mesh.cz[i] - a[2];
      if (mesh.nx[i] * dx + mesh.ny[i] * dy + mesh.nz[i] * dz < 0) flipFace(mesh, i);
    }
    return build(mesh);
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  /* ── 变换 ────────────────────────────────────────────────────────
     生成时直接算好（不是每帧算）：平移 + 绕 y 旋转 + 统一缩放。
     法线只受旋转影响，所以单独再算一遍。返回新 Mesh（原 mesh 不改）。 */
  function xform(mesh, o) {
    o = o || {};
    const p = o.p || [0, 0, 0];
    const ry = o.ry || 0;
    const s = o.s == null ? 1 : o.s;
    const sx = o.sx == null ? s : o.sx;
    const sy = o.sy == null ? s : o.sy;
    const sz = o.sz == null ? s : o.sz;
    const ca = Math.cos(ry), sa = Math.sin(ry);
    const m = new Mesh(mesh.nv, mesh.nf);
    for (let i = 0; i < mesh.nv; i++) {
      let x = mesh.vx[i] * sx, y = mesh.vy[i] * sy, z = mesh.vz[i] * sz;
      m.vx[i] = p[0] + x * ca + z * sa;
      m.vy[i] = p[1] + y;
      m.vz[i] = p[2] - x * sa + z * ca;
    }
    m.col = mesh.col.slice(); m.mat = mesh.mat; m.alpha = mesh.alpha;
    m.cull = mesh.cull; m.tag = mesh.tag;
    /* 面索引原样复制 */
    m.fa.set(mesh.fa); m.fb.set(mesh.fb); m.fc.set(mesh.fc); m.fd.set(mesh.fd);
    build(m);   // build 会重新判退化面
    return m;
  }

  /* ── 曝光与色调映射 ──────────────────────────────────────────────
     线性乘出来的颜色直接当 sRGB 用会整体偏暗（尤其是中间调），
     这是所有人第一次写软件渲染都会踩的坑：以为材质选错了色，
     其实是没做 gamma。这里用一张 1K 查找表：曝光 → 高光滚降 → gamma。
     每面查三次表，比 pow 便宜一个数量级。 */
  function makeLut(exposure, gamma) {
    const lut = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) {
      let x = (i / 255) * exposure;
      /* 高光滚降：超过 1 的部分软压，避免灯和金属直接焊成白块 */
      if (x > 1) x = 1 + (x - 1) / (1 + (x - 1) * 0.55);
      x = Math.pow(clamp(x, 0, 2), gamma) * 0.5 + Math.pow(clamp(x, 0, 2), 1) * 0.5;
      lut[i] = Math.round(clamp(x, 0, 1) * 255);
    }
    return lut;
  }

  /* ── 光照 ────────────────────────────────────────────────────────
     可以直接吃 LT.sky(...) 的输出（ambient/sun/ambI/sunI 那套），
     也可以手给。dir 是「光来的方向」（从物体指向光源）。 */
  function light(sky, o) {
    o = o || {};
    const amb = sky && sky.ambient ? sky.ambient : [60, 66, 80];
    const sun = sky && sky.sun ? sky.sun : [255, 244, 226];
    const ambI = sky && sky.ambI != null ? sky.ambI : 0.5;
    const sunI = sky && sky.sunI != null ? sky.sunI : 0.9;
    let d = o.dir || [-0.45, -0.78, 0.44];
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    d = [d[0] / dl, d[1] / dl, d[2] / dl];
    const L = {
      dir: d,
      /* 环境色带一点天顶蓝、地面暖，避免阴影发灰 */
      amb: [amb[0] / 255 * ambI, amb[1] / 255 * ambI, amb[2] / 255 * ambI],
      sun: [sun[0] / 255 * sunI, sun[1] / 255 * sunI, sun[2] / 255 * sunI],
      fog: o.fog || null,
      fogNear: o.fogNear == null ? 1600 : o.fogNear,
      fogFar: o.fogFar == null ? 9000 : o.fogFar,
      fogMax: o.fogMax == null ? 0.9 : o.fogMax,
      rim: o.rim == null ? 0.16 : o.rim,
      /* 补光：从机位方向打来的弱光。没有它，背光机位的正面是纯黑，
         再准的法线也救不回来。电影里叫 eye light。 */
      fill: o.fill == null ? 0.16 : o.fill,
      /* 半球光：天空给的漫射 + 地面反弹。只有「阴影色 × 一个系数」时，
         朝上的岩石和朝下的岩石一样暗，画面就死黑一片。
         真实世界里朝上的面看得到整片天空，所以它必须亮得多。 */
      exposure: o.exposure == null ? 1.18 : o.exposure,
      gamma: o.gamma == null ? 0.82 : o.gamma,
      /* 中性天光：从 ambient 反推会把蓝色放大 2 倍，岩石全变蓝。
         要偏色请显式传 hemiTop（黄昏给一点暖灰，夜景给冷蓝）。 */
      hemiTop: o.hemiTop || [0.36, 0.35, 0.34],
      hemiBot: o.hemiBot || [0.11, 0.10, 0.095],
      ao: o.ao == null ? 0.30 : o.ao,
      aoBase: o.aoBase == null ? -240 : o.aoBase,
      aoSpan: o.aoSpan == null ? 320 : o.aoSpan,
    };
    L._lut = makeLut(L.exposure, L.gamma);
    return L;
  }

  /* 以机位为基准布光：主光放在「相机侧后方」azimuth 度、仰角 elev 度。
     这是摄影里最稳的一种布光（侧逆光），永远不会把正面打成死黑。
     手动给 dir 很容易犯「光在相机背后」的错 —— 画面会突然全黑，
     而且因为灯还亮着，很难一眼看出是光的问题。 */
  function keyLight(sky, cam, o) {
    o = o || {};
    const az = (o.azimuth == null ? -38 : o.azimuth) * Math.PI / 180;
    const el = (o.elev == null ? 26 : o.elev) * Math.PI / 180;
    /* 视线方向（从相机指向场景） */
    const f = cam._f || [0, 0, 1];
    /* 在水平面上取「相机右方向」 */
    let rx = -f[2], rz = f[0];
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    const ca = Math.cos(az), sa = Math.sin(az);
    /* 光源方向 = 视线反向旋转 az 后抬起 el（都要取反：dir 指向光源） */
    const bx = -(f[0] * ca + rx * sa);
    const bz = -(f[2] * ca + rz * sa);
    const horiz = Math.hypot(bx, bz) || 1;
    const dir = [bx / horiz * Math.cos(el), -Math.sin(el), bz / horiz * Math.cos(el)];
    return light(sky, Object.assign({}, o, { dir }));
  }

  /* ── 着色 ────────────────────────────────────────────────────────
     每面一次：Lambert + Blinn 高光 + 边缘光 + 天光梯度 + 高度 AO。
     没有阴影贴图，但「暗面偏冷、亮面偏暖、边缘有一道亮线」这三件事
     已经足够骗过人眼 —— 它们占了「立体感」来源的绝大部分。 */
  const MAT = {
    matte: { spec: 0.06, exp: 12, rim: 1.0 },
    rock: { spec: 0.10, exp: 8, rim: 0.7 },
    metal: { spec: 0.85, exp: 42, rim: 1.4, tint: 1 },
    glass: { spec: 1.45, exp: 110, rim: 2.0, emissive: 0.10 },
    emissive: { spec: 0, exp: 1, rim: 0, glow: 1 },
    skin: { spec: 0.12, exp: 18, rim: 1.2 },
    water: { spec: 1.0, exp: 64, rim: 1.2 },
  };

  const _styleCache = new Map();
  function styleOf(r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    let s = _styleCache.get(key);
    if (s === undefined) {
      s = 'rgb(' + r + ',' + g + ',' + b + ')';
      _styleCache.set(key, s);
    }
    return s;
  }

  function shadeInto(out, nX, nY, nZ, cX, cY, cZ, camPos, base, mat, L, bump, phase) {
    /* 粗糙表面：扰动法线而不是加几何。同样能出「岩石 / 砖 / 布」的斑驳，
       成本只有一个 sin —— 加几何要多 10 倍面数。 */
    if (bump) {
      const s1 = Math.sin(cX * 0.37 + cZ * 0.29 + phase * 6.283) * Math.cos(cY * 0.21 - cX * 0.13);
      const s2 = Math.sin(cY * 0.43 - cZ * 0.31 + phase * 9.17);
      nX += s1 * bump; nY += s2 * bump; nZ += (s1 - s2) * bump * 0.6;
      const nl = Math.hypot(nX, nY, nZ) || 1;
      nX /= nl; nY /= nl; nZ /= nl;
    }
    /* 法线朝相机（双面） —— 不依赖顶点绕序，几何生成器写反了也不会变黑 */
    let vx = camPos[0] - cX, vy = camPos[1] - cY, vz = camPos[2] - cZ;
    const vl = Math.hypot(vx, vy, vz) || 1;
    vx /= vl; vy /= vl; vz /= vl;
    if (nX * vx + nY * vy + nZ * vz < 0) { nX = -nX; nY = -nY; nZ = -nZ; }

    const ndl = Math.max(0, nX * L.dir[0] + nY * L.dir[1] + nZ * L.dir[2]);
    /* 半球光：朝上的面（y 向下，nY<0）看到整片天空 */
    const up = (1 - nY) * 0.5;
    const hr = L.hemiBot[0] + (L.hemiTop[0] - L.hemiBot[0]) * up;
    const hg = L.hemiBot[1] + (L.hemiTop[1] - L.hemiBot[1]) * up;
    const hb = L.hemiBot[2] + (L.hemiTop[2] - L.hemiBot[2]) * up;
    /* 高度遮蔽：越接近地面越暗，伪造接触阴影 */
    const aoT = clamp((L.aoBase - cY) / L.aoSpan, 0, 1);
    const ao = 1 - L.ao * aoT * aoT;

    let r = base[0] * (hr * ao + L.sun[0] * ndl);
    let g = base[1] * (hg * ao + L.sun[1] * ndl);
    let b = base[2] * (hb * ao + L.sun[2] * ndl);

    if (mat.spec) {
      /* 半程向量 */
      let hx = L.dir[0] + vx, hy = L.dir[1] + vy, hz = L.dir[2] + vz;
      const hl = Math.hypot(hx, hy, hz) || 1;
      const ndh = Math.max(0, (nX * hx + nY * hy + nZ * hz) / hl);
      const s = Math.pow(ndh, mat.exp) * mat.spec;
      r += L.sun[0] * s * 230;
      g += L.sun[1] * s * 230;
      b += L.sun[2] * s * 230;
    }
    if (L.fill) {
      /* 补光按「面是否朝向相机」加权，平铺会洗掉立体感 */
      const fl = L.fill * Math.max(0, nX * vx + nY * vy + nZ * vz);
      r += base[0] * fl * 0.95;
      g += base[1] * fl * 0.95;
      b += base[2] * fl * 0.95;
    }
    if (mat.rim) {
      /* 边缘光：视线与法线越垂直越亮，勾出轮廓 */
      const rim = Math.pow(1 - Math.max(0, nX * vx + nY * vy + nZ * vz), 3.2) * L.rim * mat.rim;
      r += L.sun[0] * rim * 255 * 0.55;
      g += L.sun[1] * rim * 255 * 0.55;
      b += L.sun[2] * rim * 255 * 0.55;
    }
    if (mat.glow) {
      r = base[0] * 1.0; g = base[1] * 1.0; b = base[2] * 1.0;
    }
    const lut = L._lut;
    if (lut) {
      out[0] = lut[r < 0 ? 0 : r > 1023 ? 1023 : r | 0];
      out[1] = lut[g < 0 ? 0 : g > 1023 ? 1023 : g | 0];
      out[2] = lut[b < 0 ? 0 : b > 1023 ? 1023 : b | 0];
    } else {
      out[0] = clamp(r, 0, 255); out[1] = clamp(g, 0, 255); out[2] = clamp(b, 0, 255);
    }
    return out;
  }

  /* ── 绘制 ────────────────────────────────────────────────────────
     每帧两遍：
       ① 所有顶点投影一次（共享顶点只算一次，球体顶点能省 4 倍）
       ② 收集通过近裁剪的面，按深度降序排一次，远面先画
     4000 面 / 1080p 约 35–50ms。面数在生成侧控制（seg / rings）。 */
  let _sx = null, _sy = null, _sz = null;
  let _pm = null, _pf = null, _pz = null, _pidx = null;
  const _col = [0, 0, 0];

  function ensure(nv, nf) {
    if (!_sx || _sx.length < nv) {
      const cap = Math.max(8192, nv * 2);
      _sx = new Float32Array(cap); _sy = new Float32Array(cap); _sz = new Float32Array(cap);
    }
    if (!_pm || _pm.length < nf) {
      const cap = Math.max(8192, nf * 2);
      _pm = new Int32Array(cap); _pf = new Int32Array(cap);
      _pz = new Float64Array(cap); _pidx = new Int32Array(cap);
    }
  }

  function fogT(z, L) {
    if (!L.fog) return 0;
    return clamp((z - L.fogNear) / (L.fogFar - L.fogNear), 0, 1) * L.fogMax;
  }

  function draw(g, cam, meshes, L, o) {
    o = o || {};
    const list = Array.isArray(meshes) ? meshes : [meshes];
    let totalV = 0, totalF = 0;
    for (let i = 0; i < list.length; i++) { totalV += list[i].nv; totalF += list[i].nf; }
    ensure(totalV, totalF);

    const f = cam._f, r = cam._r, u = cam._u;
    const ccx = cam._cx, ccy = cam._cy, foc = cam._foc, near = cam.near;
    const px = cam.pos[0], py = cam.pos[1], pz = cam.pos[2];
    const gA = g.globalAlpha == null ? 1 : g.globalAlpha;

    /* ① 顶点投影 */
    let vi = 0;
    const offs = new Array(list.length);
    for (let mi = 0; mi < list.length; mi++) {
      const m = list[mi];
      offs[mi] = vi;
      for (let i = 0; i < m.nv; i++) {
        const dx = m.vx[i] - px, dy = m.vy[i] - py, dz = m.vz[i] - pz;
        const z = dx * f[0] + dy * f[1] + dz * f[2];
        _sz[vi] = z;
        if (z > near) {
          const inv = foc / z;
          _sx[vi] = ccx + (dx * r[0] + dy * r[1] + dz * r[2]) * inv;
          _sy[vi] = ccy + (dx * u[0] + dy * u[1] + dz * u[2]) * inv;
        } else {
          _sx[vi] = -1e9; _sy[vi] = -1e9;
        }
        vi++;
      }
    }

    /* ② 收集可见面（带相机空间深度） */
    let n = 0;
    for (let mi = 0; mi < list.length; mi++) {
      const m = list[mi], base = offs[mi];
      for (let i = 0; i < m.nf; i++) {
        if (m.skip[i]) continue;
        const a = base + m.fa[i], b = base + m.fb[i], c = base + m.fc[i];
        if (_sz[a] <= near || _sz[b] <= near || _sz[c] <= near) continue;
        if (m.fd[i] >= 0 && _sz[base + m.fd[i]] <= near) continue;
        const z = (m.cx[i] - px) * f[0] + (m.cy[i] - py) * f[1] + (m.cz[i] - pz) * f[2];
        if (z <= near) continue;
        _pm[n] = mi; _pf[n] = i; _pz[n] = z; n++;
      }
    }

    /* ③ 排序：远 → 近（画家算法） */
    const idx = _pidx.subarray(0, n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const depth = _pz;
    idx.sort((A, B) => depth[B] - depth[A]);

    /* ④ 逐面着色填充（wire>0 时按比例削弱填充，另外补一层线框） */
    g.lineJoin = 'round';
    const seam = o.seam == null ? 0.6 : o.seam;
    const wf = clamp(o.wire == null ? 0 : o.wire, 0, 1);
    /* fill 可以单独给：让「实体长出来」和「线框退下去」错开，
       否则中间态永远是「淡实体 + 亮线框」，读起来还是线框。 */
    const fillMul = o.fill == null ? 1 - wf : clamp(o.fill, 0, 1);
    let lastAlpha = -1;
    for (let k = 0; k < n; k++) {
      const mi = _pm[idx[k]], i = _pf[idx[k]];
      const m = list[mi], base = offs[mi];
      const a = base + m.fa[i], b = base + m.fb[i], c = base + m.fc[i];
      const d = m.fd[i] >= 0 ? base + m.fd[i] : -1;

      const wantA = gA * (o.alpha == null ? 1 : o.alpha) * m.alpha * fillMul;
      if (wantA !== lastAlpha) { g.globalAlpha = wantA; lastAlpha = wantA; }
      if (wantA <= 0.004) continue;

      const mat = MAT[m.mat] || MAT.matte;
      const bs = m.colorBy ? m.colorBy(m.cx[i], m.cy[i], m.cz[i], i) : m.col;
      let rr, gg, bb;
      if (mat.glow) { rr = bs[0]; gg = bs[1]; bb = bs[2]; }
      else {
        shadeInto(_col, m.nx[i], m.ny[i], m.nz[i], m.cx[i], m.cy[i], m.cz[i], cam.pos, bs, mat, L, m.bump, m.bn ? m.bn[i] : 0);
        rr = _col[0] | 0; gg = _col[1] | 0; bb = _col[2] | 0;
      }
      const fg = fogT(_pz[idx[k]], L);
      if (fg > 0.002) {
        const fc = L.fog;
        rr = (rr + (fc[0] - rr) * fg) | 0;
        gg = (gg + (fc[1] - gg) * fg) | 0;
        bb = (bb + (fc[2] - bb) * fg) | 0;
      }
      const st = styleOf(rr < 0 ? 0 : rr > 255 ? 255 : rr, gg < 0 ? 0 : gg > 255 ? 255 : gg, bb < 0 ? 0 : bb > 255 ? 255 : bb);
      g.fillStyle = st;
      g.beginPath();
      g.moveTo(_sx[a], _sy[a]);
      g.lineTo(_sx[b], _sy[b]);
      g.lineTo(_sx[c], _sy[c]);
      if (d >= 0) g.lineTo(_sx[d], _sy[d]);
      g.closePath();
      g.fill();
      /* 同色描边：补掉相邻面之间的 1px 抗锯齿缝，深色背景上尤其明显 */
      if (seam > 0) { g.strokeStyle = st; g.lineWidth = seam; g.stroke(); }
    }
    /* ⑤ 线框：单独一遍。放在同一循环里会为了切 fillStyle/strokeStyle 反复打断状态 */
    if (wf > 0.004) {
      g.globalAlpha = gA * wf;
      g.strokeStyle = o.wireColor || 'rgb(122,214,236)';
      g.lineWidth = o.wireWidth == null ? 1 : o.wireWidth;
      g.beginPath();
      for (let k = 0; k < n; k++) {
        const mi = _pm[idx[k]], i = _pf[idx[k]];
        const m = list[mi], base = offs[mi];
        /* 只描「结构线」：每隔 step 个面取一个，否则密集网格会糊成一片 */
        if (o.wireStep && (i % o.wireStep) !== 0) continue;
        const a = base + m.fa[i], b = base + m.fb[i], c = base + m.fc[i];
        const d = m.fd[i] >= 0 ? base + m.fd[i] : -1;
        g.moveTo(_sx[a], _sy[a]);
        g.lineTo(_sx[b], _sy[b]);
        g.lineTo(_sx[c], _sy[c]);
        if (d >= 0) g.lineTo(_sx[d], _sy[d]);
        g.closePath();
      }
      g.stroke();
    }
    g.globalAlpha = gA;
    return { faces: n, verts: vi };
  }

  /* ── 形态变换 ────────────────────────────────────────────────────
     两个**拓扑相同**的 mesh（顶点数、面数一致）之间插值。
     用途：「一团纸 → 一只鸟」「线框 → 实体」「方块 → 字母」。
     光有线性插值会像橡皮泥被拉长；真正好看的是三件事：
       · stagger：每个顶点错开一点起步，形成「涌过去」而不是整体平移
       · arc：路径沿法线鼓出，走弧线不是直线
       · 顶点自己带一点旋涡，避免中间态塌成一团
     中间态 k∈(0,1) 时两边都「不像」，这是正常的 —— 观众看的是过程。 */
  function morph(a, b, k, o) {
    o = o || {};
    if (a.nv !== b.nv) throw new Error('SD.morph: 顶点数不同（' + a.nv + ' vs ' + b.nv + '）');
    if (a.nf !== b.nf) throw new Error('SD.morph: 面数不同（' + a.nf + ' vs ' + b.nf + '）');
    const stagger = o.stagger == null ? 0.35 : o.stagger;
    const arc = o.arc == null ? 0.0 : o.arc;
    const swirl = o.swirl == null ? 0.0 : o.swirl;
    const m = new Mesh(a.nv, a.nf);
    const kk = clamp(k, 0, 1);
    for (let i = 0; i < a.nv; i++) {
      /* 每个顶点一个固定相位：同一帧内错开，但同一顶点每帧位置一致 */
      const ph = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const d = stagger * Math.abs(ph);
      const t = clamp((kk - d) / Math.max(1e-6, 1 - stagger), 0, 1);
      const e = t * t * (3 - 2 * t);
      let x = a.vx[i] + (b.vx[i] - a.vx[i]) * e;
      let y = a.vy[i] + (b.vy[i] - a.vy[i]) * e;
      let z = a.vz[i] + (b.vz[i] - a.vz[i]) * e;
      if (arc) {
        /* 中点鼓出：sin(πt) 在两端为 0、中间最大 */
        const bulge = Math.sin(Math.PI * e) * arc;
        x += (a.nx[i % a.nf] || 0) * bulge;
        y += (a.ny[i % a.nf] || 0) * bulge;
        z += (a.nz[i % a.nf] || 0) * bulge;
      }
      if (swirl) {
        const ang = Math.sin(Math.PI * e) * swirl * (ph - 0.5);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const dx = x - a.cx[0], dz = z - a.cz[0];
        x = a.cx[0] + dx * ca - dz * sa;
        z = a.cz[0] + dx * sa + dz * ca;
      }
      m.vx[i] = x; m.vy[i] = y; m.vz[i] = z;
    }
    m.fa.set(a.fa); m.fb.set(a.fb); m.fc.set(a.fc); m.fd.set(a.fd);
    m.col = (o.color || a.col).slice();
    m.mat = o.mat || a.mat;
    m.alpha = a.alpha;
    m.bump = a.bump;
    build(m);
    return m;
  }

  const SD = {
    Mesh, mesh: build, build, fromFaces,
    box, lathe, sphere, tube, terrain, plane,
    xform, morph, light, keyLight, MAT,
    draw,
    _shade: shadeInto,
  };
  root.SD = SD;
  if (typeof module === 'object' && module.exports) module.exports = SD;
})(typeof globalThis !== 'undefined' ? globalThis : this);

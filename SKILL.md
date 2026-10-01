---
name: html-to-video
description: 把 HTML/Canvas 动画逐帧渲染成 MP4（可配乐、可出 GIF）。当用户说「用代码做视频」「HTML 转视频」「导出 MP4/GIF」「做个动态图解/宣传片/数据动画」「逐帧渲染」时使用。自带渲染器，装好依赖后一条命令出片。
agent_created: true
---

# html-to-video · 代码逐帧做视频

## 这套东西是什么

**不是 AI 生成视频**，是**用代码逐帧画视频**：

```
写 HTML/Canvas，把画面写成 frame(t) 纯函数
   → 无头浏览器逐帧 seek 到 t，截图
   → ffmpeg 编成 H.264 MP4
字幕 / 运镜 / 转场全在代码里，改代码重渲即可
```

优点：**确定性**（同输入同输出）、**可控到帧**、**中文文字完美**、**零费用**。
最适合做：讲解动画、动态图解、产品演示、数据可视化动画、游戏宣传片。
不适合：实拍感/氛围镜头（那种走 VideoGen）。

## 先装依赖（只需一次）

渲染器需要 **Node 工作区**（内含 playwright + 完整版 ffmpeg）。一条命令搞定：

```bash
bash scripts/install-deps.sh                       # 工作区默认 ~/.workbuddy/binaries/node/workspace
bash scripts/install-deps.sh /path/to/workspace    # 或自己指定
```

它会自动探测本机浏览器缓存、挑匹配的 playwright 版本、装完整版 ffmpeg，
并把工作区路径写进 `~/.workbuddy/.html2video-env`，之后 render.sh / smoke.sh 开箱即用。

手动装也行（工作区需含 `playwright` + `@ffmpeg-installer/ffmpeg`），然后自己写配置：

```bash
# ~/.workbuddy/.html2video-env
WB_NODE_WORKSPACE="<你的 node 工作区绝对路径>"
```

> 也可以用环境变量临时指定：`export WB_NODE_WORKSPACE="<路径>"`。
> **不要**把路径写进 `${VAR:-默认值}`——用户名若含撇号（如 `O'Brien`），
> bash 会把撇号当引号开始，报 `bad substitution`。

### 四条硬约束（踩过，别重犯）

1. **Playwright 版本必须和浏览器缓存匹配。**
   `playwright-core@X` 只认自己在 `browsers.json` 里声明的 chromium build 号，
   不匹配就报 "Executable doesn't exist"。

   → **别猜版本，用 `scripts/install-deps.sh`**，它会跑 `scripts/detect-env.js` 探测缓存后自动挑版本。
   单独探测：`node scripts/detect-env.js`（输出 `RECOMMEND_PW=...`）。
   已知映射：build 1148→1.49.1、1155→1.50.1、1169→1.52.0、1187→1.55.0、1208→1.58.0。

   **注意**：某些网络环境下 chromium 下载会反复中断（表现为缓存目录里躺着半截的残缺目录）。
   此时优先复用已有缓存而非升级——这正是探测脚本存在的理由。

2. **Playwright 自带的那个 ffmpeg 没用。**
   `ms-playwright/ffmpeg-*/ffmpeg-win64.exe` 是 `--disable-everything` 编译的，
   只有 VP8 编码 + webm 封装，**没有 H.264、没有 GIF、连 PNG 解码都没开**。
   必须用 `@ffmpeg-installer/ffmpeg` 的完整版。

3. **ESM 不认 `NODE_PATH`。** `.mjs` 里 `import 'playwright'` 必然 `ERR_MODULE_NOT_FOUND`。
   → 辅助脚本一律写 **CJS（`.cjs` / `require`）**。

4. **PATH 不可靠。** 尤其在 Git Bash / Windows 上，塞进 PATH 的 Windows 风格路径会被转换搞坏。
   → **别靠 PATH 传 ffmpeg，用 `FFMPEG` 环境变量**（渲染器已支持）。

## 出片流程

### 第 1 步：写动画 HTML

用 `assets/animation-skeleton.html` 当骨架。**核心契约**（渲染器靠它工作）：

```js
// 必须暴露这两个
window.__seek = (t) => { /* 把 t 时刻的画面完整重绘一帧 */ };
window.__ready = true;                 // 就绪信号

// 渲染器会注入 window.__seekRender = true，
// 此时必须【冻结自驱时钟】，完全由外部 __seek 推帧（保证确定性）
if (window.__seekRender) { renderAt(0); window.__ready = true; }
else { /* 浏览器预览：requestAnimationFrame 自驱循环 */ }
```

**画布就是唯一输出**：`<canvas width=1920 height=1080>`，CSS 定位在 `left:0; top:0`，
body `margin:0`。渲染器用 `clip:{x:0,y:0,width:W,height:H}` 截左上角，所以画布必须正好铺满视口、不能居中。

**禁止使用的 class 名**（渲染器注入的 CSS 会无条件隐藏它们，元素会凭空消失）：
`.no-record .progress .progress-bar .counter .tCur .phases .phase-label .phase .replay .masthead .kicker .title .footer`
另外别给 `position:fixed/sticky` 的元素加 `<button>`，会被启发式规则当成播放控件隐藏。

**中文字体**：`'"Microsoft YaHei", "PingFang SC", system-ui, sans-serif'`；等宽用 `'ui-monospace, Consolas, monospace'`。

### 第 2 步：冒烟测试（**别跳**）

先只截几帧，确认契约就绪、没控制台报错、画面没糊，再跑全量：

```bash
bash assets/smoke.sh animation.html
# SMOKE_T="0,1,2" SMOKE_W=1280 SMOKE_H=720 bash assets/smoke.sh animation.html
```

### 第 3 步：全量渲染

```bash
bash assets/render.sh animation.html --duration=12 --fps=60 --width=1920 --height=1080 --concurrency=4
```

- 输出与 HTML 同名的 `.mp4`
- 帧数 = `fps × duration`。**12s@60fps = 720 帧，实测约 6~7 分钟**（concurrency=4）
- `--concurrency` 调高能提速，但每个 worker 一个 Chromium 页面，注意内存
- 编码约 1 分钟（crf 18 / preset medium）

### 第 4 步：配乐 / 派生格式

```bash
FF="<node工作区>/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe"   # Windows
# 其它平台：FF="<node工作区>/node_modules/@ffmpeg-installer/ffmpeg"

# 混 BGM（0.8s 淡入 / 1.4s 淡出，视频流不重编码）
"$FF" -y -i animation.mp4 -i "$BGM" -filter_complex \
  "[1:a]atrim=0:DUR,afade=t=in:st=0:d=0.8,afade=t=out:st=DUR-1.4:d=1.4,volume=0.5[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart animation-bgm.mp4

# GIF（两阶段 palette 优化，否则糊）
"$FF" -y -i animation.mp4 -vf "fps=15,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" palette.png
"$FF" -y -i animation.mp4 -i palette.png -lavfi "fps=15,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" animation.gif

# 竖屏：改 HTML 画布尺寸后重渲，别用裁剪
```

### 第 5 步：独立验证（**必做**，别只看渲染器自己说成功）

```bash
# 从成片回抽帧，亲眼确认画面
"$FF" -y -ss 4.0 -i animation-bgm.mp4 -frames:v 1 -q:v 2 out/verify-4.0.jpg
# 校验规格
"$FF" -hide_banner -i animation-bgm.mp4 2>&1 | grep -E "Duration|Stream"
# 解码完整性（无输出即无错误）
"$FF" -v error -i animation-bgm.mp4 -f null -
```

⚠️ **验证渲染时务必换输出名或另建目录**。渲染器输出名固定为「HTML 同名 .mp4」，
拿真文件名跑一次短渲染验证，会把成品覆盖成短版。（踩过，只能重新编码。）

## 渲染中途 ffmpeg 失败怎么办

**帧不会丢**：渲染器在编码失败时保留 `.seek-tmp-*/` 里的全部 PNG。
修好 ffmpeg 后直接手动编码，不必重截 720 帧：

```bash
"$FF" -y -framerate 60 -i .seek-tmp-*/frame-%06d.png -c:v libx264 -pix_fmt yuv420p \
  -crf 18 -preset medium -r 60 -movflags +faststart animation.mp4
```

顺带：`.seek-tmp-*/` 有 720 张 PNG，**约 316 MB**。留着的好处是能换画质/编码重出，不用重渲。不想要就删。

## 文件说明

| 文件 | 作用 |
|---|---|
| `scripts/render-video-seek.js` | 渲染器内核（冻结时钟 + 逐帧 seek 截图 + ffmpeg 编码），自包含 |
| `scripts/detect-env.js` | 探测本机浏览器缓存，输出该装哪个 playwright 版本 |
| `scripts/install-deps.sh` | 一键装依赖并写配置（探测 → 装 → 落地配置文件） |
| `assets/render.sh` | 全量渲染包装器，自动解析 node 工作区与 ffmpeg 路径 |
| `assets/smoke.sh` / `smoke.cjs` | 冒烟测试：验证 `__seek` 契约 + 试截关键帧 |
| `assets/animation-skeleton.html` | 动画骨架模板，已实现完整渲染契约 |

## 设计品味另找专业分工

本技能只负责「环境 + 出片链路」。分镜方法、镜头语言、视觉风格属于设计范畴，
交给专门的设计类技能处理，别在这里重复造。

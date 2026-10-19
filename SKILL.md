---
name: html-to-video
description: 把 HTML/Canvas 动画逐帧渲染成 MP4（可配乐、可出 GIF、可出透明层）。当用户说「用代码做视频」「HTML 转视频」「导出 MP4/GIF」「做个动态图解/宣传片/数据动画」「逐帧渲染」时使用。自带渲染器与 11 个开箱即用模板（含多镜头讲解片、竖屏 9:16、前后对比、流程图、字幕卡）、图标/人物/运镜素材库，支持透明输出、外部字幕时间轴与 JSON 镜头表，装好依赖后一条命令出片。
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
最适合做：讲解动画、动态图解、产品演示、数据可视化动画、宣传片片头。
不适合：实拍感/氛围镜头（那种走 VideoGen）。

**能拿它做什么**（`assets/templates/` 里 11 个模板直接改字就能出片）：

| 模板 | 用途 | 出片 |
|---|---|---|
| `explainer.html` | **多镜头讲解片**：片头 / 人物+气泡 / 要点 / 条形对比 / 片尾，镜头带转场，可喂 JSON 镜头表；横屏恰好三条要点时自动并排成三栏，竖屏（1080×1920）另有上下版式 | `--duration=17.6` |
| `title-card.html` | 视频片头：主标题逐字弹入 + 副标题 | `--duration=6` |
| `bar-chart.html` | 条形图/排名：条形依次生长，数值同步滚动 | `--duration=6` |
| `line-chart.html` | 折线趋势：折线生长 + 数据点亮起 + 末点浮标 | `--duration=8` |
| `number-counter.html` | 大数字/KPI：从 0 滚到目标值 + 涨跌标签 | `--duration=7` |
| `timeline.html` | 时间线/流程：中轴生长，节点逐个点亮 | `--duration=7` |
| `vertical-card.html` | **竖屏 9:16 卡片**：大字标题 + 大数字，抖音/视频号/Reels 用 | `--duration=6 --width=1080 --height=1920` |
| `compare.html` | **前后对比**：左右两栏对照，结论条收口 | `--duration=7` |
| `flow-steps.html` | **流程图动画**：步骤依次点亮，当前步高亮 | `--duration=7` |
| `subtitle-card.html` | **逐句解说卡**：一句话一句地出，底部带进度条 | `--duration=8` + `--srt` |
| `vertical-subtitle.html` | **竖屏字幕卡**：关键词高亮，9:16 原生版式 | `--duration=8 --width=1080 --height=1920` + `--srt` |

每个模板**单文件自包含**，顶部有一个显眼的 `CFG` 配置块，改文案/数据即可 ——
不用懂 canvas 也能出片。五个新模板还支持换主题（见「换配色」一节）。
想做别的，再看 `assets/animation-skeleton.html` 从零写。

**做「一支片子」而不是「一段动画」**：用 `assets/lib/scenes.js` 写多镜头 + 转场，
镜头表还能用 `--story=shots.json` 外置 —— LLM 写 JSON 比写几百行 canvas 代码可靠得多。
详见下面「多镜头与转场」一节。

### 尺寸：模板跟视口走，不用手改

10 个模板都按 `window.innerWidth/innerHeight` 设画布，所以**换任何尺寸都不裁切**：

```bash
# 横屏 1080p（默认）
bash assets/render.sh title-card.html --duration=6 --fps=60
# 竖屏 9:16
bash assets/render.sh title-card.html --duration=6 --fps=60 --width=1080 --height=1920
# 720p / 4K 同理
bash assets/render.sh title-card.html --duration=6 --fps=60 --width=1280 --height=720
```

模板内部用三档缩放把设计稿落到实际画布：

| 变量 | 含义 | 1920×1080 | 1080×1920 |
|---|---|---|---|
| `SX = W/1920` | 横向尺寸、左右边距 | 1 | 0.5625 |
| `SY = H/1080` | 纵向尺寸、行距 | 1 | 1.7778 |
| `SF = √(SX·SY)` | 字号、线宽、圆角、模糊 | 1 | 1 |

字号用面积等比（`SF`）而不是跟宽度走 —— 换成竖屏时字**不会变小**，只是版式铺开。
`1920×1080` 下三者都等于 1，所以**默认输出与旧版逐像素一致**（实测 PSNR = inf）。

**自己写的动画也照这个来**，否则改 `--width/--height` 会静默裁掉右下角：

```js
const cv = document.getElementById('stage');
cv.width  = window.innerWidth;      // ← 不要写死 1920
cv.height = window.innerHeight;     // ← 不要写死 1080
```

渲染器现在会主动量一次画布尺寸，比视口小就明确告警（不再静默出半张图）。

## 先装依赖（只需一次）

渲染器需要 **Node 工作区**（内含 playwright + 完整版 ffmpeg）。一条命令搞定：

```bash
bash scripts/install-deps.sh                       # 工作区默认 ~/.workbuddy/binaries/node/workspace
bash scripts/install-deps.sh /path/to/workspace    # 或自己指定
```

它会自动探测本机浏览器缓存、挑匹配的 playwright 版本、装完整版 ffmpeg，
并把工作区路径写进 `~/.workbuddy/.html2video-env`，之后 render.sh / smoke.sh / qa.sh 开箱即用。

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

### 第 0 步（最省事的路）：挑一个模板改字

```bash
cp assets/templates/bar-chart.html my-video.html
# 打开 my-video.html，只改顶部 CFG 里的 title / data / note
bash assets/render.sh my-video.html --duration=6 --fps=60
```

模板有**字幕安全区**意识：文字不会落在画面底部 15%（烧录字幕后会被盖住）。
自己做版式时也照这个来。

### 第 1 步：写动画 HTML（模板不够用时）

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

**铁律：每一帧画面 = 时间 t 的纯函数。** 不要依赖「上一帧」的状态，
不要用 `Math.random()` / `Date.now()` / `performance.now()`——那会让同输入不同输出，
QA 里的「确定性」会亮红灯，而且多 worker 并行渲染会各渲各的。

**画布就是唯一输出**：`<canvas width=1920 height=1080>`，CSS 定位在 `left:0; top:0`，
body `margin:0`。渲染器用 `clip:{x:0,y:0,width:W,height:H}` 截左上角，所以画布必须正好铺满视口、不能居中。

（渲染器也支持 DOM/CSS/SVG 动画，同样只需暴露 `__seek`——但注意：DOM 动画每帧重排较慢，
纯 canvas 通常更稳更快。）

**禁止使用的 class 名**（渲染器注入的 CSS 会无条件隐藏它们，元素会凭空消失）：
`.no-record .progress .progress-bar .counter .tCur .phases .phase-label .phase .replay .masthead .kicker .title .footer`
另外别给 `position:fixed/sticky` 的元素加 `<button>`，会被启发式规则当成播放控件隐藏。
（想让某块**出现在成片里**，给它加 `data-record-keep="true"` 就能豁免启发式隐藏。）

**中文字体**：`'"Microsoft YaHei", "PingFang SC", system-ui, sans-serif'`；等宽用 `'ui-monospace, Consolas, monospace'`。

### 第 2 步：冒烟测试（**别跳**）

先只截几帧，确认契约就绪、没控制台报错、画面没糊，再跑全量：

```bash
bash assets/smoke.sh animation.html
# SMOKE_T="0,1,2" SMOKE_W=1280 SMOKE_H=720 bash assets/smoke.sh animation.html
```

更快的迭代方式：**只渲一小段**，几秒就能看到动态效果。

```bash
bash assets/render.sh animation.html --from=3 --to=5 --fps=30   # 只渲 3s–5s
bash assets/render.sh animation.html --stills=1,3,5            # 只导出三张静帧
```

### 第 3 步：全量渲染

```bash
bash assets/render.sh animation.html --duration=12 --fps=60 --width=1920 --height=1080 --concurrency=4
```

常用参数：

| 参数 | 作用 |
|---|---|
| `--duration` / `--from` / `--to` | 时长 / 只渲某段（秒）。给了范围时输出名变成 `名.起-止s.mp4`，**不会覆盖成品** |
| `--stills=0.5,2.0` | 只导出这些时刻的 PNG，不编码 |
| `--fps` / `--width` / `--height` | 帧率与分辨率 |
| `--concurrency` | 并行 worker 数（每个 worker 一个 Chromium 页面，注意内存）。给 `auto` 按 CPU 与内存自己挑 |
| `--audio=<file>` | 编码后自动混音（视频流直接 copy，不重编码） |
| `--gop=<秒>` | 关键帧间隔，如 `--gop=1` 每秒一个关键帧，方便后期按秒 seek |
| `--keep-frames` | 成功也保留逐帧 PNG（换 CRF 重编码时不必重截） |
| `--resume` | 上次渲到一半被打断？接着渲，已渲好的帧直接复用（参数和上次不一致会拒绝，见下） |
| `--alpha` | 透明背景输出（ProRes 4444 `.mov`），叠到实拍 / AI 生成画面上用，见下 |
| `--srt=<file>` | 外部字幕时间轴（SRT / VTT / JSON），注入 `window.__cues`，见下。同义参数 `--cues` |
| `--cue-log=<file>` | 导出 `frame,t,cue_index,cue_start,cue_end` CSV，用来核对字幕到底对不对轴 |
| `--story=<file>` | 镜头表 JSON，注入 `window.__story`，整份换掉剧本（见「多镜头与转场」） |
| `--scene-log=<file>` | 导出镜头时间轴 CSV；镜头表总时长与 `--duration` 不一致会告警 |
| `--gif[=fps,宽]` | 出片后顺手产 GIF（默认 15fps / 宽 960），两阶段 palette 优化，不重渲 |
| `--poster=<秒>` | 出片后顺手抽一张封面静帧 `.jpg`，发站 / 社媒用 |
| `--batch=<file.json>` | 一串任务按顺序渲，最后打汇总表；单个失败不连坐已渲好的，但整体非零退出 |
| `--headed` | 开着浏览器窗口渲（调试用；并发自动降到 1，免得弹一排窗口） |
| `--allow-errors` | 页面报错不判失败（默认：有报错 → 非零退出） |
| `--keep-chrome` | 不隐藏播放控件（调试用） |
| `--readytimeout=8` | 等 `__seek` 就绪的秒数（启动慢的大字体/大数据可调大） |
| `--no-serve` | 用 `file://` 加载页面（默认走本地 http server，见下） |

**ESM / fetch 项目直接能渲**。渲染器默认起一个只绑 `127.0.0.1` 的本地 http server 来加载页面 ——
`file://` 下 `<script type="module">` 和 `fetch()` 会被 CORS 拦死，用 Vite/esbuild 组织的动画、
读本地 JSON 的项目根本起不来；走 http 就没这些事。渲染开头会打印这个地址，排障时直接粘到浏览器里看控制台最方便。
服务器起不来会自动退回 `file://` 并提示（只警告，不判失败）。

- 输出与 HTML 同名的 `.mp4`
- 帧数 = `fps × duration`。**12s@60fps = 720 帧，实测约 6~7 分钟**（concurrency=4）
- 编码约 1 分钟（crf 18 / preset medium）

**渲染结束有页面报错会非零退出**（但成片照样产出，方便你核对）。

### 渲到一半断了，别从零开始

长片子（60fps × 30s = 1800 帧）跑到 80% 崩了，从零重来最伤。加 `--resume` 就接着渲：

```bash
bash assets/render.sh animation.html --fps=60 --duration=30 --resume
# ▸ resume: 已复用 1432 帧，还需渲 368 帧
```

规则三条，都是为了「续出来的片子和一次渲完的片子一模一样」：

- **帧先写 `.part` 再改名**。被 kill 的那一帧不会留下半个 PNG 冒充「已完成」，所以复用的帧都是真画完的。
- **参数变了直接拒绝**。上次 30fps、这次 60fps 会把两批帧混着编码，片子前后节奏不一致还不报错 ——
  所以 `fps / 尺寸 / 范围 / 渲染模式` 任一不同就退出并打印「上次 vs 这次」，让你自己决定删不删。
- **帧号必须连续**。缺一张 ffmpeg 会静默提前收尾、成片莫名变短，所以编码前按 `[起,止)` 逐个核号，
  有洞就报出来并提示加 `--resume` 补。

临时目录固定在 HTML 旁边的 `.seek-tmp-resume/`（不加 `--resume` 时仍是一次性目录，并发渲互不干扰）。
渲完自动清掉；中途想留着就配 `--keep-frames`。
这是故意的：页面报错常常意味着「整片黑屏 / 缺了半屏内容」，以前的版本会一路说成功，
直到你回抽帧才发现——现在它会在编码前就把报错打出来，并在最后判失败。

### 透明输出：把文字层叠到别人拍的画面上

AI 生成的背景 + 代码生成的文字层，是现在最省钱的组合（模型画文字必糊，代码画文字精确到像素）。
`--alpha` 就是为这条路准备的：

```bash
bash assets/render.sh animation.html --duration=6 --fps=30 --alpha
# → animation.mov（ProRes 4444 / yuva444p12le，背景透明）
```

**模板侧要配合一件事**：读到 `window.__transparent` 为真时跳过背景层绘制。
目前 `title-card`、`compare`、`flow-steps`、`subtitle-card`、`vertical-subtitle` 这 5 个已经这样写，
直接加 `--alpha` 就有透明效果；其余 5 个是满版图表，本来就要底色，加了也只会得到不透明的片子。
自己写的动画照这个来：

```js
const TRANSPARENT = !!window.__transparent;
function drawFrame(t) {
  g.clearRect(0, 0, W, H);
  if (!TRANSPARENT) {
    // 底色 / 全屏渐变 / 光斑 —— 这些都要跳过
    g.fillStyle = '#080A10';
    g.fillRect(0, 0, W, H);
  }
  // 文字、图形照常画
}
```

**全屏的半透明光晕也要一起跳过**。哪怕它只有 5% 不透明度，叠到实拍上会让整片区域泛白，
剪辑师第一反应是「这素材脏」。实测：只跳底色、留着光斑时，四角 alpha=12（不是 0）；
全跳之后四角 alpha=0、只有 3.7% 的像素不透明（全是文字）。

**体积代价**（960×540 / 2s / 20 帧实测）：

| 输出 | 体积 | 用途 |
|---|---|---|
| H.264 `.mp4` | 118 KB | 成片直接发 |
| ProRes 4444 `.mov` | 760 KB（6.5×） | 拖进剪辑软件叠层 |

**只有 ProRes，没有 VP9**。试过 `--pix_fmt yuva420p` + `-auto-alt-ref 0`，文件确实从 7.8KB
涨到 16.8KB（alpha 数据写进去了），但 Chromium 播出来整帧 alpha 全 0 —— 连文字都透明；
换 lossless、固定码率、`-lag-in-frames 0` 都一样。既然没法自证正确，就不把它作为选项发布。
要小体积透明素材，用 ProRes 导入剪辑软件后再导 webm，那是那边的活。

### 字幕挂外部时间轴：配音改了，字幕跟着走

字幕文案写在模板的 `CFG.lines` 里最省事，但一旦要配音，时间点就得跟着音频走 ——
总不能每改一句都回去手数秒数。所以支持直接喂一坨字幕文件：

```bash
bash assets/render.sh subtitle-card.html --duration=8 --srt=voice.srt --cue-log=cues.csv
```

- 支持 **SRT**（`HH:MM:SS,mmm`）、**WebVTT**（`MM:SS.mmm` 也行）、**JSON**（`[{start,end,text}]`）。
- 解析一次，注入 `window.__cues`，模板按当前帧的 `t` 自己去查该显示哪句。
  模板里用 `--srt` 时**优先读 `__cues`，没有才回退 `CFG.lines`**，所以同一个模板两种用法都成立。
- `--cue-log` 输出 `frame,t,cue_index,cue_start,cue_end` 的 CSV。把「字幕时间对不对」
  变成一个能算的数：拿每句的首帧时间减 SRT 的起点，就是误差。
  实测 4 句 / 80 帧，每句误差 **0 ms**，帧覆盖数与理论值完全一致。

模板侧只要两行就能支持：

```js
const cues = (window.__cues && window.__cues.length) ? window.__cues : CFG.lines;
const cur = cues.find(c => t >= c.start && t < c.end) || cues[cues.length - 1];
```

**字幕别踩进底部 15%**。那是各平台的进度条 / 点赞按钮区，写进去等于白写。
`qa.js` 会提示「进字幕带」，四个新模板的竖屏版式都留出了这条安全带。

### 换配色：改一个字段，不用碰画布代码

`assets/templates/themes.js` 里有三套调色板，模板只要写 `CFG.theme`：

```js
const CFG = {
  theme: 'paper',   // midnight（默认，暗色）| paper（浅色）| neon（黑紫霓虹）
  ...
};
```

| 主题 | 观感 | 适合 |
|---|---|---|
| `midnight` | 近黑底 + 暖橙强调 | 通用，默认 |
| `paper` | 米白底 + 深墨文字 | 文档、教学、要打印或投影的场合 |
| `neon` | 黑紫底 + 紫/青霓虹 | 科技、发布会、社区宣传 |

要微调就传对象，缺的字段自动从 `midnight` 补：

```js
theme: { bg: '#0B1020', accent: '#22D3EE' }
```

四个新模板（`compare` / `flow-steps` / `subtitle-card` / `vertical-subtitle`）已经接入。
**`themes.js` 是外部脚本，拷模板时连它一起拷**；只拷 HTML 也能跑（模板里有兜底色板），
只是换不了主题。`test/templates-contract.test.mjs` 会检查「登记了主题能力就必须真的引入 themes.js」。

### 第 4 步：配乐 / 派生格式

渲染时加 `--audio=` 就能直接混音；需要更细的控制时用下面的命令：

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

### 第 5 步：自动化验收（**交付前跑**）

渲染器只保证「帧渲出来了」，不保证「画面是对的」。这一步把肉眼最容易漏的问题量化：

```bash
bash assets/qa.sh animation.html --duration=12 --fps=30
```

它做的事：

| 维度 | 量什么 |
|---|---|
| 确定性 | 抽 首/中/末 3 个时刻，各做两轮逐像素比对：同页面 seek 回去（验累积状态）+ 全新页面重渲（验随机初始化）。不一致 = 画面里混了随机数/时钟/累积状态 |
| 动感 | 相邻帧变化像素占比（运动%）、静止帧对比例、**最长连续静止秒数** |
| 流畅 | 相邻帧差的峰值/中位数，报「跳变」时刻 |
| 框景 | 从加载起 hook `fillText/strokeText` + DOM 文字行框 → 报**半截字 / 叠字 / 进字幕带 / 近空白** |
| 字体 | 声明的字体是否可用、是否悄悄回退到兜底字体（缺字形是静默失败） |
| 报错 | pageerror / console.error 清单（有则判失败，退出码非零） |

产物：`qa/qa.md`（表 + 线索清单）、`qa/qa.json`（原始数字）、`qa/<名>.heat.png`（运动热图）。

判据的脾气：**经验阈值，不是规则**。运动 0.5%–8% 多数好看；最长静止 ≥3s 会提示
（有意定格可以忽略）；跳变 >0 先去看那一帧；框景线索只是「去看一眼」的提示，不让 QA 失败。

关键参数：`--safe-bottom=0.15`（画面底部这个比例内出现文字就警告，烧录字幕会盖住；`0` 关掉）、
`--skip=0.35`（跳过段首的镜头冲击）、`--samples=120`（采样帧数上限）。

**采样间隔要 ≤0.1s**，否则一段快速位移在相邻两帧之间看着就像「跳」——那是采样假象不是穿帮。
`qa.sh` 在间隔 >0.15s 时会提示该把 `--samples` 提到多少。（实测：同一段 title-card，
`--fps=6` 报 2 处跳变，`--fps=30` 报 0 处。）

> 已知盲区：画进离屏 canvas 再 `drawImage` 上来的文字追不到；被图形挡住的字查不到；
> 采样从 `--skip` 之后开始，开场瞬间的问题看不到。这些都在报告里说明了。

### 第 6 步：独立验证（别只看工具说成功）

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
用 `--from/--to` 时输出名自带范围后缀，天然不会覆盖；也可以直接换目录。

## 动效库：assets/lib/motion.js

缓动、弹簧、步进、错开、拍号的纯函数库，和「冻结时钟 + `__seek(t)`」天然契合：

```html
<script src="../lib/motion.js"></script>
<script>
  const p = MO.expoOut(MO.seg(t, 0.3, 1.4));      // 0..1 进度
  const y = MO.lerp(80, 0, p);                    // 位移
  const s = 1 + MO.settle(t - 1.2, 0.06);         // 到位后的余振
</script>
```

选缓动的一句话：讲解类用 `MO.smooth` / `sineInOut`（两端都停稳）；发布会用 `MO.appleOut` / `MO.snappy`；
动态大字用 `expoOut` + `MO.springHz`；纸片/拼贴按 `MO.step(t, 12)` 一拍二；逐项入场用 `MO.stagger`。

**别让画面「死」掉**：一段动效做完后如果还要停留好几秒，加一点持续微动
（慢速光扫、呼吸、漂浮 `MO.float`），否则观众会觉得视频卡住了。模板里都带了这一手。

## 多镜头与转场：assets/lib/scenes.js

一支能看的片子是「多镜头 + 转场」，不是几段动画硬拼。以前只能渲几段再拿 ffmpeg 拼
（还要自己算 offset）；现在**一个 HTML 里写镜头表**，渲染器照旧只管按 `t` 推帧，
转场在页面内合成 —— 一条命令照样出片。

```html
<script src="../lib/scenes.js"></script>
<script>
  const TL = SC.build([
    { id: 'hook',  dur: 3.0, draw: (g, lt, c) => drawHook(g, lt, c) },
    { id: 'point', dur: 4.0, trans: { in: 'slide', dur: 0.5 }, draw: (g, lt, c) => drawPoint(g, lt, c) },
  ], { lead: 0.4, tail: 0.6 });

  function frame(t) { SC.paint(g, TL, clamp(t, 0, TL.dur - 1e-4), { W, H, bg: TH.bg }); }
</script>
```

| 转场 | 观感 | 什么时候用 |
|---|---|---|
| `fade` | 交叉溶解 | **文字类片子的默认**，讲理、讲解、数据 |
| `dip` | 经底色过渡 | 两段情绪差得远；或两镜版式完全换掉 |
| `slide` | 下一镜整块推入 | 满幅图形 / 照片 / 色块之间 |
| `push` | 两镜贴着一起走 | 同上，更要方向感（流程往下走） |
| `rise` | 下一镜从下方升起 | 竖屏、解说卡（两镜共用左边距时才稳） |
| `zoom` | 变焦穿过 | 满幅画面之间，强调「一口气穿过去」 |
| `wipe` | 竖边扫擦 + 扫描亮线 | 科技感、数据揭示（满幅图形） |
| `cut` | 硬切 | 节奏紧、或转场时长给 0 |

**选型铁律：画面里有文字，就只用 `fade` / `dip`。** 带位移的转场会把上一镜的文字
从中间切一半推走，两镜标题还会在同一位置叠成乱码 —— 观感是「画面坏了」，不是
「镜头动了」。位移类转场只留给边缘没有语义的画面（满幅图形、照片、色块）。

五条约定（踩过的）：

1. **每个镜头的 `draw` 必须把背景画满**。转场是按 alpha 叠加两张画，
   镜头自己留透明，交叉溶解时会透出底色，看着像闪一下。
2. **镜头动画一律用局部时间 `lt`**，不要用全局 `t`；转场窗口里上一镜的 `lt`
   正好走到它自己的末尾（不会越界），所以镜头代码不用为转场写特例。
3. **带转场的镜头，别在 `draw` 里再叠一层整体淡入**。转场已经在做透明度了，
   两层同时压 alpha，前 0.3 秒会糊成一团。`ctx.trans.dur > 0` 就跳过自己那层。
4. **退场侧要先把内容撤干净**：转场窗口里 `ctx.role = { side:'a'|'b', p }`，
   `side==='a'` 时把内容 alpha 按 `p` 收到 0（背景照画），`side==='b'` 的内容
   晚 `0.22 × 转场时长` 起步。这样两镜内容永不同时在场 —— 这是文字类片子做溶解
   不翻车的关键，标准写法见 `assets/templates/explainer.html` 的 `draw` 包装。
5. **转场是重叠的**：总时长 = Σ镜头时长 − Σ转场时长。加了转场，片子不会变长。
6. `SC.expose(TL)` 把镜头表挂到 `window.__sceneTable`，配渲染器 `--scene-log` 导出 CSV；
   **镜头表总时长与 `--duration` 不一致会告警**（否则结尾静默多一截静止画面）。

镜头表可以整份外置，LLM 写 JSON 最省事：

```bash
bash assets/render.sh explainer.html --duration=17.6 --fps=30 --story=shots.json
```

```json
[{ "kind": "title", "id": "hook", "dur": 3.0, "title": "..." },
 { "kind": "talk",  "id": "why",  "dur": 3.5, "say": "...", "trans": { "in": "fade", "dur": 0.45 } }]
```

## 运镜：assets/lib/camera.js

画面元素都到位之后还剩几秒 —— 那几秒最容易「死」，`qa.js` 会报「最长连续静止」。
加一点持续运镜能活过来，而且比堆装饰元素更不抢戏。

```js
const cam = CAM.breath();                       // 呼吸：1.4% 的持续缩放，周期 4.2s
CAM.withCam(g, CAM.at(cam, t, W, H), W, H, () => { /* 画内容 */ });
```

| kind | 用途 |
|---|---|
| `breath()` | 极轻缩放，专门治「画面死了」 |
| `kenburns({from,to})` | 缓慢推拉 / 平移（照片、大图镜头） |
| `handheld` | 手持微抖：确定性伪噪声（**不是** `Math.random()`），多 worker 结果一致 |
| `shake` | 撞击式震动，会衰减到 0（强调、转场落点） |
| `stack([...])` | 多个运镜叠加：位移相加、缩放相乘 |

两条硬规矩：**运镜前先把底色铺满**（缩放/平移会露边）；
**缩放小于 1 一定露边**，要拉远就把内容画得比视口大。

## 素材库：图标 / 人物 / 图形

想画图标、箭头、卡片、人物，不用找图、也不用从零写 path —— `assets/lib/` 里有三个零依赖库：

| 库 | 提供 |
|---|---|
| `shapes.js` | 40+ 线性图标（`SH.icon(g,'bolt',x,y,48,{color})`）、卡片 / 胶囊 / 箭头 / 正交连接线 / 虚线框 / 进度弧、网格 / 点阵 / 柔光 / 暗角 / 流动极光 / 胶片颗粒 |
| `figures.js` | 参数化扁平小人：`FIG.draw(g, FIG.preset('dev', {x,y,h,t,pose:'wave',mood:'happy'}))`，发型 / 表情 / 姿势 / 配色全可调，自带对话气泡 `FIG.say()`；`FIG.shade(hex, -0.14)` 取同色系深浅一档 —— 袖子和上衣必须差一档，否则手会像浮在衣服上的色块 |
| `camera.js` | 见上 |

**为什么是代码画的元件，不是预置图片素材包**：版权干净（没有一张外部图）、
风格必然统一（同一套圆角线宽、跟着主题走）、任意分辨率都清晰、不占体积。
**刻意不做**卡通人物位图包 / 标志性建筑照片包 —— 版权说不清、风格和用户自己的画面打架，
还会把仓库撑成几十 MB 的二进制库。要人物就用 `figures.js` 参数化生成。

```js
SH.icon(g, 'bolt', x, y, 48, { color: TH.accent, width: 2.5 });
SH.card(g, { x, y, w, h }, { fill: TH.panel, stroke: TH.faint, radius: 18 });
FIG.draw(g, FIG.preset('host', { x: W * 0.22, y: H * 0.84, h: H * 0.42, t, pose: 'wave' }));
```

## 中文字体与跨机器一致

默认用系统字体（`Microsoft YaHei` / `PingFang SC`）。**这意味着"确定性"只在单机成立**：
同一个 HTML 换台没有这款字体的机器（比如 Mac），字形就会变。

- 只是本机出片 → 不用管。
- 要跨机器/跨人复现 → 自己内嵌一份子集字体：

```css
@font-face { font-family: 'MyCJK'; src: url('fonts/subset.woff2') format('woff2'); font-display: block; }
```

子集化（只保留画面里真正用到的字，一个思源黑体 1.38MB → 约 300KB）：
装 `fonttools` 后 `pyftsubset 源字体.ttf --text-file=<把文案导出成 txt> --flavor=woff2 --output-file=subset.woff2`。
**只统计会画到画面上的字**——把注释里的中文也算进去，子集会胖很多倍。

`qa.sh` 会检查字体可用性，并在「声明的字体其实没生效（悄悄回退了）」时给出警告。

## 渲染中途 ffmpeg 失败怎么办

**帧不会丢**：渲染器在编码失败时保留 `.seek-tmp-*/` 里的全部 PNG，并打印出可直接粘贴的编码命令。
修好 ffmpeg 后手动编码即可，不必重截 720 帧：

```bash
"$FF" -y -framerate 60 -start_number 0 -i .seek-tmp-*/frame-%06d.png -c:v libx264 -pix_fmt yuv420p \
  -crf 18 -preset medium -r 60 -movflags +faststart animation.mp4
```

顺带：`.seek-tmp-*/` 有 720 张 PNG，**约 316 MB**。成功渲染后会自动删；加 `--keep-frames`
可以主动留住（换画质重编码时省一次渲染）。

> 某些沙箱/托管环境给 `fs.rmSync` 套了「批量删除保护」，一次删几十个文件会被拦下。
> 这时渲染器会提示「逐帧目录没能自动删除」并给出路径，**成片不受影响**——手动删那个目录即可。
> 这也是为什么有时会看到残留的 `.seek-tmp-*` 目录。

## 文件说明

| 文件 | 作用 |
|---|---|
| `scripts/render-video-seek.js` | 渲染器内核（冻结时钟 + 逐帧 seek 截图 + ffmpeg 编码 + 报错判定），自包含 |
| `scripts/qa.js` | 自动化验收（确定性/动感/流畅/框景/字体/报错），纯 Node 零新依赖 |
| `scripts/lib/hide-chrome.cjs` | 「隐藏播放控件」的共享规则，渲染器与验收器用同一份，规则不会漂移 |
| `scripts/lib/local-server.cjs` | 本地 http 静态服务器（只绑 127.0.0.1），解锁 ESM / fetch；零新依赖 |
| `scripts/detect-env.js` | 探测本机浏览器缓存，输出该装哪个 playwright 版本 |
| `scripts/install-deps.sh` | 一键装依赖并写配置（探测 → 装 → 落地配置文件） |
| `scripts/bench.js` | 性能基线：量 `s/帧` 并估算长片耗时，产出 `bench/bench.md` |
| `assets/render.sh` | 全量渲染包装器，自动解析 node 工作区与 ffmpeg 路径 |
| `assets/smoke.sh` / `smoke.cjs` | 冒烟测试：验证 `__seek` 契约 + 试截关键帧 |
| `assets/qa.sh` | 验收包装器，环境解析同上 |
| `assets/animation-skeleton.html` | 动画骨架模板，已实现完整渲染契约 |
| `scripts/lib/cues.cjs` | 字幕时间轴解析（SRT / VTT / JSON），会自动排序并修掉时长非正、首尾重叠的 cue |
| `scripts/lib/qa-rules.cjs` | 验收判据的纯函数（框景 / 持续 / 分块 / 统计），可脱离浏览器单测 |
| `assets/templates/*.html` | 11 个开箱即用模板（多镜头讲解片/片头/条形图/折线/大数字/时间线/竖屏卡/前后对比/流程图/解说卡/竖屏字幕卡），改 CFG 即用 |
| `assets/templates/themes.js` | 三套内置主题（midnight / paper / neon），新模板用它换配色 |
| `assets/lib/motion.js` | 动效时间库（缓动/弹簧/步进/错开），纯函数、零依赖 |
| `assets/lib/scenes.js` | 多镜头时间轴 + 8 种转场（cut/fade/dip/slide/push/rise/zoom/wipe），纯函数、零依赖 |
| `assets/lib/camera.js` | 运镜（推拉 / 呼吸 / 手持微抖 / 撞击震动），确定性伪噪声，不用随机数 |
| `assets/lib/shapes.js` | 图形元件：40+ 线性图标 / 卡片 / 箭头 / 正交连接线 / 背景纹理 |
| `assets/lib/figures.js` | 参数化人物（发型 / 表情 / 姿势 / 配色）+ 对话气泡 |

### 渲得有多慢：自己量一次，别信文档

不同机器差 3–5 倍（CPU、内存、画面复杂度都影响），所以这里不写「约几分钟」：

```bash
npm run bench                                  # 两个页面 × 两档分辨率 × 两种并发 → bench/bench.md
node scripts/bench.js --frames=60 --html=assets/templates/explainer.html
```

表里给 `s/帧`（已把并发算进去）和「10s@60fps 预估」。**并发不是越大越好**：
超过 CPU 核数之后页面之间抢 CPU，`s/帧` 不降反升，表上能直接看出来。

## 设计品味另找专业分工

本技能只负责「环境 + 出片链路 + 质量门」。分镜方法、镜头语言、视觉风格属于设计范畴，
交给专门的设计类技能处理，别在这里重复造。

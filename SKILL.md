---
name: html-to-video
description: 把 HTML/Canvas 动画逐帧渲染成 MP4（可配乐、可出 GIF）。当用户说「用代码做视频」「HTML 转视频」「导出 MP4/GIF」「做个动态图解/宣传片/数据动画」「逐帧渲染」时使用。自带渲染器与 5 个开箱即用模板，装好依赖后一条命令出片。
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

**能拿它做什么**（`assets/templates/` 里 5 个模板直接改字就能出片）：

| 模板 | 用途 | 出片 |
|---|---|---|
| `title-card.html` | 视频片头：主标题逐字弹入 + 副标题 | `--duration=6` |
| `bar-chart.html` | 条形图/排名：条形依次生长，数值同步滚动 | `--duration=6` |
| `line-chart.html` | 折线趋势：折线生长 + 数据点亮起 + 末点浮标 | `--duration=8` |
| `number-counter.html` | 大数字/KPI：从 0 滚到目标值 + 涨跌标签 | `--duration=7` |
| `timeline.html` | 时间线/流程：中轴生长，节点逐个点亮 | `--duration=7` |

每个模板**单文件自包含**，顶部有一个显眼的 `CFG` 配置块，改文案/数据即可 ——
不用懂 canvas 也能出片。想做别的，再看 `assets/animation-skeleton.html` 从零写。

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
| `--concurrency` | 并行 worker 数（每个 worker 一个 Chromium 页面，注意内存） |
| `--audio=<file>` | 编码后自动混音（视频流直接 copy，不重编码） |
| `--gop=<秒>` | 关键帧间隔，如 `--gop=1` 每秒一个关键帧，方便后期按秒 seek |
| `--keep-frames` | 成功也保留逐帧 PNG（换 CRF 重编码时不必重截） |
| `--allow-errors` | 页面报错不判失败（默认：有报错 → 非零退出） |
| `--keep-chrome` | 不隐藏播放控件（调试用） |

- 输出与 HTML 同名的 `.mp4`
- 帧数 = `fps × duration`。**12s@60fps = 720 帧，实测约 6~7 分钟**（concurrency=4）
- 编码约 1 分钟（crf 18 / preset medium）

**渲染结束有页面报错会非零退出**（但成片照样产出，方便你核对）。
这是故意的：页面报错常常意味着「整片黑屏 / 缺了半屏内容」，以前的版本会一路说成功，
直到你回抽帧才发现——现在它会在编码前就把报错打出来，并在最后判失败。

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
| 确定性 | 同一时刻渲两次逐像素比对。不一致 = 画面里混了随机数/时钟/累积状态 |
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
| `scripts/detect-env.js` | 探测本机浏览器缓存，输出该装哪个 playwright 版本 |
| `scripts/install-deps.sh` | 一键装依赖并写配置（探测 → 装 → 落地配置文件） |
| `assets/render.sh` | 全量渲染包装器，自动解析 node 工作区与 ffmpeg 路径 |
| `assets/smoke.sh` / `smoke.cjs` | 冒烟测试：验证 `__seek` 契约 + 试截关键帧 |
| `assets/qa.sh` | 验收包装器，环境解析同上 |
| `assets/animation-skeleton.html` | 动画骨架模板，已实现完整渲染契约 |
| `assets/templates/*.html` | 5 个开箱即用模板（片头/条形图/折线/大数字/时间线），改 CFG 即用 |
| `assets/lib/motion.js` | 动效时间库（缓动/弹簧/步进/错开），纯函数、零依赖 |

## 设计品味另找专业分工

本技能只负责「环境 + 出片链路 + 质量门」。分镜方法、镜头语言、视觉风格属于设计范畴，
交给专门的设计类技能处理，别在这里重复造。

# html-to-video · 用代码逐帧做视频

[![CI](https://github.com/wx4766/html-to-video/actions/workflows/ci.yml/badge.svg)](https://github.com/wx4766/html-to-video/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

把 HTML / Canvas 动画**逐帧渲染成 MP4**（可配乐、可出 GIF）。

不是 AI 文生视频，而是：

```
写 HTML/Canvas，把画面写成 frame(t) 纯函数
   → 无头浏览器逐帧 seek 到时刻 t，截图
   → ffmpeg 编成 H.264 MP4
```

字幕、运镜、转场全在代码里，**改一行代码重渲即可**。

## 为什么用它

| | |
|---|---|
| **确定性** | 同样的输入永远得到同样的输出，可复现、可版本管理 |
| **可控到帧** | 任意帧率（真 60fps，不是插帧），任意时刻精确对齐 |
| **文字完美** | 中文字体渲染正常，不会像文生视频那样糊成一团或错别字 |
| **零费用** | 本地跑，不调任何 API |
| **有质量门** | 内置自动化验收：确定性、卡顿、跳变、半截字、叠字、字幕带、字体回退 |
| **开箱即用** | 6 个模板改个配置块就出片，不用从零学 canvas |
| **横竖屏都行** | 模板跟视口自适应，16:9 / 9:16 换 `--width/--height` 即可，不裁切 |

适合：讲解动画、动态图解、产品演示、数据可视化动画、游戏宣传片。
不适合：实拍感 / 氛围镜头（那个应该走 VideoGen）。

## 6 个开箱即用模板

拷贝一个，改顶部 `CFG` 里的文案和数据，直接出片。

| | 模板 | 用途 |
|---|---|---|
| [![](docs/demo-title-card.gif)](docs/demo-title-card.mp4) | `assets/templates/title-card.html` | **片头标题卡**：主标题逐字弹入 + 副标题 + 标签 |
| [![](docs/demo-bar-chart.gif)](docs/demo-bar-chart.mp4) | `assets/templates/bar-chart.html` | **条形图 / 排名**：条形依次生长，数值同步滚动，第一条高亮 |
| [![](docs/demo-line-chart.gif)](docs/demo-line-chart.mp4) | `assets/templates/line-chart.html` | **折线趋势**：折线生长 + 数据点亮起 + 末点数值浮标 |
| [![](docs/demo-number-counter.gif)](docs/demo-number-counter.mp4) | `assets/templates/number-counter.html` | **大数字 / KPI**：从 0 滚到目标值 + 涨跌标签 + 进度条 |
| [![](docs/demo-timeline.gif)](docs/demo-timeline.mp4) | `assets/templates/timeline.html` | **时间线 / 流程**：中轴生长，节点逐个点亮 |
| [<img src="docs/demo-vertical-card.gif" width="150" alt="竖屏卡">](docs/demo-vertical-card.mp4) | `assets/templates/vertical-card.html` | **竖屏 9:16 卡**：大字标题 + 大数字，抖音 / 视频号 / Reels 用 |

> 动图只为让你看见「它在动」；**点动图打开原片**看真实画质（横屏 1080p，竖屏 1080×1920）。
> 静帧大图在 `docs/preview-*.png`。

```bash
cp assets/templates/bar-chart.html my-video.html
# 改 my-video.html 顶部的 CFG：title / data / note
bash assets/render.sh my-video.html --duration=6 --fps=60
```

### 横屏 / 竖屏：换两个参数就行

模板都按视口设画布，**不用改代码**：

```bash
bash assets/render.sh title-card.html --duration=6 --fps=60                              # 1920×1080
bash assets/render.sh title-card.html --duration=6 --fps=60 --width=1080 --height=1920   # 9:16
bash assets/render.sh title-card.html --duration=6 --fps=60 --width=1280 --height=720    # 720p
```

模板内部用三档缩放落版：`SX = W/1920`（横向）、`SY = H/1080`（纵向）、
`SF = √(SX·SY)`（字号 / 线宽）。1920×1080 下三者都是 1，所以默认输出保持不变；
换竖屏时字号不缩、版式铺开。自己写的动画照这三行来，就不会出现「改了 --width 只截到左上角」。

> 渲染器现在会主动量画布尺寸，比视口小会明确告警，不再静默出半张图。

## 安装

需要 Node.js >= 18。

```bash
git clone https://github.com/wx4766/html-to-video.git ~/.workbuddy/skills/html-to-video
cd ~/.workbuddy/skills/html-to-video
bash scripts/install-deps.sh
```

`install-deps.sh` 会自动做完三件事：

1. 探测本机 Playwright 浏览器缓存，挑**匹配的** playwright 版本
2. 装完整版 ffmpeg（Playwright 自带的那个是残废的，见下）
3. 把工作区路径写进 `~/.workbuddy/.html2video-env`

想自己指定工作区：`bash scripts/install-deps.sh /path/to/workspace`

## 快速开始

```bash
# 1. 拿骨架模板改自己的动画
cp assets/animation-skeleton.html my-animation.html

# 2. 冒烟：先截几帧确认画面（别跳过）
bash assets/smoke.sh my-animation.html

# 3. 只渲一小段，快速看效果（几秒出片）
bash assets/render.sh my-animation.html --from=3 --to=5 --fps=30

# 4. 全量渲染
bash assets/render.sh my-animation.html --duration=12 --fps=60 --width=1920 --height=1080 --concurrency=4
# → my-animation.mp4

# 5. 交付前验收（确定性问题、卡顿、半截字、叠字、字幕带、字体回退，一次全查）
bash assets/qa.sh my-animation.html --duration=12 --fps=30
```

12 秒 60fps = 720 帧，实测约 6~7 分钟（concurrency=4）。

### 渲染参数

| 参数 | 作用 |
|---|---|
| `--duration` / `--from` / `--to` | 时长 / 只渲某段（秒）。给了范围时输出 `名.起-止s.mp4`，不会覆盖成品 |
| `--stills=0.5,2.0` | 只导出这些时刻的 PNG，不编码 |
| `--fps` / `--width` / `--height` | 帧率与分辨率 |
| `--concurrency` | 并行 worker 数（每个 worker 一个 Chromium 页面） |
| `--audio=<file>` | 编码后自动混音（视频流 copy，不重编码） |
| `--gop=<秒>` | 关键帧间隔（`--gop=1` 便于后期按秒 seek） |
| `--keep-frames` | 成功也保留逐帧 PNG（换 CRF 重编码不必重截） |
| `--resume` | 上次渲到一半断了？接着渲，已渲好的帧直接复用 |
| `--allow-errors` | 页面报错不判失败（默认有报错就非零退出） |
| `--readytimeout=8` | 等 `__seek` 就绪的秒数（大字体 / 大数据启动慢时调大） |
| `--no-serve` | 用 `file://` 加载页面（默认走本地 http server，见下） |

**渲染结束时如果有页面控制台报错，会非零退出**（成片照样产出，方便核对）。
这是刻意的：报错通常意味着黑屏或缺内容，早年的版本会一路说成功，直到你回抽帧才发现。

### 断点续渲：渲到 80% 崩了，不用从零开始

1800 帧的片子跑到一半被掐掉，最伤的是重来一遍。加 `--resume` 接着渲：

```bash
node scripts/render-video-seek.js animation.html --fps=60 --duration=30 --resume
# ▸ resume: 已复用 1432 帧，还需渲 368 帧
```

三条规则都是为了保证**续出来的片子和一次渲完的片子逐像素一致**：

- 帧先写 `.part` 再改名 —— 被 kill 的那一刻不会留下半张图冒充「已完成」，复用的都是真画完的帧
- 参数变了直接拒绝（`fps` / 尺寸 / 范围任一项不同）—— 两批不同参数的帧混着编码，片子前后节奏会不一致，
  而且**不报错**。报错里会打印「上次 vs 这次」，删不删由你决定
- 编码前按帧号逐个核对连续覆盖 —— 缺一张 ffmpeg 会静默提前收尾，成片莫名变短

临时目录固定为 HTML 旁边的 `.seek-tmp-resume/`（不加 `--resume` 时仍是一次性目录，并发渲互不干扰），
渲完自动清掉；想留着配 `--keep-frames`。

### ESM / fetch 项目直接能渲

渲染器默认起一个**只绑 `127.0.0.1` 的本地 http server** 来加载页面（零新依赖，Node 内置 `http`）。
`file://` 下 `<script type="module">` 和 `fetch()` 会被 CORS 拦死 —— 用 Vite/esbuild 组织的动画、
读本地 JSON 的项目根本起不来；走 http 就没这些事，而且是 `file://` 的严格超集。

渲染开头会打印这个地址，排障时直接粘到浏览器里看控制台最方便。
服务器起不来会自动退回 `file://` 并提示（只警告，不判失败）。

## 动画要满足的契约

渲染器靠这两个全局钩子驱动，**必须有**：

```js
window.__seek = (t) => { /* 把 t 时刻的画面完整重绘一帧 */ };
window.__ready = true;

// 渲染器会注入 window.__seekRender = true，
// 此时必须冻结自驱时钟，完全由外部 __seek 推帧（保证确定性）
if (window.__seekRender) { renderAt(0); window.__ready = true; }
else { /* 浏览器预览：requestAnimationFrame 自驱循环 */ }
```

`assets/animation-skeleton.html` 已实现完整契约，直接从它改。

**铁律：每一帧 = 时间 t 的纯函数。** 不要用 `Math.random()` / `Date.now()`，
不要依赖上一帧的状态——否则同输入不同输出，多 worker 并行会各渲各的（验收里的「确定性」会亮红灯）。

**画布就是唯一输出**：`<canvas>` 定位在 `left:0; top:0`，body `margin:0`。
渲染器截左上角，画布必须正好铺满视口、**不能居中**。

**别用这些 class 名**（渲染器注入的 CSS 会无条件隐藏它们，元素会凭空消失）：

```
.no-record .progress .progress-bar .counter .tCur .phases .phase-label
.phase .replay .masthead .kicker .title .footer
```

反过来，想让某块**出现在成片里**，给它加 `data-record-keep="true"` 就能豁免启发式隐藏。

## 动效库：assets/lib/motion.js

缓动、弹簧、步进、错开、拍号的纯函数库，和「冻结时钟 + `__seek(t)`」天然契合。

```html
<script src="../lib/motion.js"></script>
<script>
  const p = MO.expoOut(MO.seg(t, 0.3, 1.4));      // 0..1 进度，快出慢停
  const y = MO.lerp(80, 0, p);
  const s = 1 + MO.settle(t - 1.2, 0.06);         // 到位后的余振
  const items = MO.stagger(t, 5, { t0: 0.4 });    // 5 项依次入场
</script>
```

选缓动：讲解类 `MO.smooth` / `sineInOut`（两端都停稳）；发布会 `MO.appleOut` / `MO.snappy`；
动态大字 `expoOut` + `MO.springHz`；纸片/拼贴 `MO.step(t, 12)` 一拍二。

**别让画面「死」掉**：动效做完后若还要停留数秒，加一点持续微动（慢速光扫、呼吸），
否则观众会觉得视频卡住。模板里都带了这一手。

## 自动化验收：qa.sh

```bash
bash assets/qa.sh my-animation.html --duration=12 --fps=30
```

| 维度 | 量什么 |
|---|---|
| 确定性 | 抽 首/中/末 3 个时刻，各做「同页面 seek 回去」+「全新页面重渲」两轮逐像素比对 |
| 动感 | 运动%、静止帧对比例、**最长连续静止秒数** |
| 流畅 | 相邻帧差峰值/中位数，报「跳变」时刻 |
| 框景 | hook `fillText` + DOM 文字行框 → 半截字 / 叠字 / 进字幕带 / 近空白 |
| 字体 | 字体是否可用、是否悄悄回退到兜底字体 |
| 报错 | pageerror / console.error（有则判失败） |

产物：`qa/qa.md`、`qa/qa.json`、`qa/<名>.heat.png`（运动热图）。
纯 Node 实现，**零额外依赖**（像素运算借 Chromium 自己解码，不引 numpy / sharp）。

阈值是经验值不是规则：运动 0.5%–8% 多数好看；最长静止 ≥3s 会提示（有意定格可忽略）；
跳变 >0 先去看那一帧；框景线索只是「去看一眼」的提示，不会让验收失败。

**采样间隔要 ≤0.1s**，否则一段快速位移在相邻两帧之间看着就像「跳」——那是采样假象不是穿帮。
间隔 >0.15s 时会提示该把 `--samples` 提到多少。

## 配乐与派生格式

```bash
FF="<工作区>/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe"   # Windows
# 其它平台：FF="<工作区>/node_modules/@ffmpeg-installer/ffmpeg"

# 混 BGM（0.8s 淡入 / 1.4s 淡出，视频流不重编码）
"$FF" -y -i animation.mp4 -i "$BGM" -filter_complex \
  "[1:a]atrim=0:DUR,afade=t=in:st=0:d=0.8,afade=t=out:st=DUR-1.4:d=1.4,volume=0.5[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart animation-bgm.mp4

# GIF（两阶段 palette 优化，否则糊）
"$FF" -y -i animation.mp4 -vf "fps=15,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" palette.png
"$FF" -y -i animation.mp4 -i palette.png -lavfi "fps=15,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" animation.gif
```

也可以直接让渲染器混音：`--audio=bgm.mp3`。

## 中文字体与跨机器一致

默认用系统字体（`Microsoft YaHei` / `PingFang SC`）。这意味着「确定性」**只在单机成立**——
换台没有这款字体的机器，字形就变了。要跨机器复现就内嵌子集字体：

```css
@font-face { font-family: 'MyCJK'; src: url('fonts/subset.woff2') format('woff2'); font-display: block; }
```

子集化（思源黑体 1.38MB → 约 300KB）：装 `fonttools` 后

```bash
pyftsubset 源字体.ttf --text-file=文案.txt --flavor=woff2 --output-file=subset.woff2
```

只统计会画到画面上的字——把注释里的中文也算进去，子集会胖很多倍。
`qa.sh` 会检查字体可用性并提示「声明的字体其实没生效（悄悄回退了）」。

## 常见问题

**报 `Executable doesn't exist`**
Playwright 版本和浏览器缓存 build 号不匹配。跑 `node scripts/detect-env.js` 看该装哪个版本，
或干脆重跑 `bash scripts/install-deps.sh`。

**Playwright 自带的 ffmpeg 不能用**
`ms-playwright/ffmpeg-*/ffmpeg-win64.exe` 是 `--disable-everything` 编译的，
只有 VP8 + webm，**没有 H.264、没有 GIF、连 PNG 解码都没开**。必须用 `@ffmpeg-installer/ffmpeg` 的完整版。

**chromium 下不下来**
某些网络环境会反复中断。此时正确做法是**复用已有缓存**而不是升级——
`install-deps.sh` 就是为此设计的：它会迁就缓存挑版本。

**Windows 上路径含撇号（如 `C:\Users\O'Brien\...`）**
- bash 里别把路径写进 `${VAR:-默认值}`，撇号会被当引号开始 → `bad substitution`。本项目的配置文件机制就是绕这个的。
- 传给 Node 的路径别用 Git Bash 的 `pwd`（返回 `/c/Users/...`，Node 会解析成 `C:\c\Users\...`）。

**编码中途失败，帧会丢吗**
不会。渲染器会保留 `.seek-tmp-*/` 里的全部 PNG 并打印可直接粘贴的编码命令，不必重截：

```bash
"$FF" -y -framerate 60 -start_number 0 -i .seek-tmp-*/frame-%06d.png -c:v libx264 \
  -pix_fmt yuv420p -crf 18 -preset medium -r 60 -movflags +faststart animation.mp4
```

（`--from` 渲染时把 `-start_number 0` 换成对应的起始帧号。）

**渲染成功但提示「逐帧目录没能自动删除」**
某些沙箱/托管环境给 `fs.rmSync` 套了「批量删除保护」，一次删几十个文件会被拦下。
渲染器会提示并给出目录路径，**成片不受影响**，手动删那个目录即可。

## 目录结构

```
html-to-video/
├── SKILL.md                       技能说明（WorkBuddy 读取）
├── package.json                   可 npm install；engines: node >= 18
├── CONTRIBUTING.md                贡献指南（加模板的四条硬约定在这里）
├── scripts/
│   ├── render-video-seek.js       渲染器内核：冻结时钟 + 逐帧 seek + ffmpeg 编码 + 报错判定
│   ├── qa.js                      自动化验收：确定性/动感/流畅/框景/字体/报错
│   ├── lib/hide-chrome.cjs        隐藏播放控件的共享规则（渲染器与验收器同一份）
│   ├── lib/local-server.cjs       本地 http 静态服务器（解锁 ESM / fetch，零新依赖）
│   ├── lib/testing.mjs            测试公用件（依赖路径解析 / 子进程 / PSNR 探针）
│   ├── detect-env.js              探测浏览器缓存，输出该装哪个 playwright 版本
│   └── install-deps.sh            一键装依赖并写配置
├── test/
│   ├── render-smoke.test.mjs      真渲两段（16:9 / 9:16），验分辨率与尺寸告警
│   ├── qa-clean.test.mjs          正常模板必须 PASS
│   ├── qa-detects.test.mjs        对照组必须 FAIL（六类缺陷）
│   ├── templates-contract.test.mjs 模板契约静态检查
│   └── fixtures/broken.html       故意做坏的对照组页面
├── .github/workflows/ci.yml       PR 自动跑 npm test
└── assets/
    ├── render.sh                  全量渲染包装器
    ├── qa.sh                      验收包装器
    ├── smoke.sh / smoke.cjs       冒烟测试：验证契约 + 试截关键帧
    ├── animation-skeleton.html    动画骨架模板（已实现完整渲染契约）
    ├── lib/motion.js              动效时间库（缓动/弹簧/步进/错开）
    └── templates/                 6 个开箱即用模板
        ├── title-card.html        片头标题卡
        ├── bar-chart.html         条形图 / 排名
        ├── line-chart.html        折线趋势
        ├── number-counter.html    大数字 / KPI
        ├── timeline.html          时间线 / 流程
        └── vertical-card.html     竖屏 9:16 卡片
```

## 开发与测试

```bash
npm install          # 装 playwright（ffmpeg 见上面「安装」，必须是完整版）
npm test             # 10 个用例，约 1 分钟
```

测试里有一对**对照组**，这是整个项目最该守住的东西：

| 用例 | 断言 | 防的是什么 |
|---|---|---|
| `qa-clean` | 正常模板必须 PASS | 判据过严 → 天天误报，人就不看了 |
| `qa-detects` | `test/fixtures/broken.html` 必须 FAIL | 判据过松 → 质量门变成装饰 |

只调松不放对照组，等于把质量门拆了。改 `scripts/qa.js` 时两个都跑一遍。

## 贡献

欢迎 PR。**最需要的是新模板**（逐句解说卡、前后对比图、流程图动画都很缺）。

加模板的四条硬约定（渲染契约 / 画布跟随视口 / 字幕安全区 / 别定格太久）写在
[CONTRIBUTING.md](CONTRIBUTING.md)，照 `assets/templates/title-card.html` 抄骨架最快。

提 Bug 请带上**复现命令**和 `qa/qa.md` —— 比贴截图有用得多。

## License

MIT

`assets/lib/motion.js`（动效时间库）移植自 [huashu-art-motion](https://github.com/huashu-art-motion) 的
`scripts/engine/lib/motion.js`（MIT），去掉了对原作者引擎的依赖，改成自包含。感谢原作者。

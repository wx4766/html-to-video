# 更新日志

本项目的所有重要变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 版本号怎么定

| 位 | 什么时候 +1 | 用户要做什么 |
|---|---|---|
| 主版本 `x.0.0` | 渲染契约不兼容：`window.__seek` / `CFG` 结构、CLI 参数语义变了 | 自己改过的模板要跟着改 |
| 次版本 `1.x.0` | 新增参数、新增模板、新增能力 | 什么都不用改，旧命令照旧能跑 |
| 修订号 `1.2.x` | 只修 bug、调阈值、改文档 | 直接升 |

渲染契约（模板必须暴露 `window.__seek` / `window.__ready`、接受 `window.__seekRender` 冻结时钟）
是**稳定接口**，不轻易动；模板内部版式、QA 阈值属于实现细节，随时可能调整。

---

## [未发布]

## [1.2.0] - 2026-10-18

这一版的主题是「从能出片，到能进生产流程」：透明层可以直接叠到实拍上，字幕能挂外部时间轴，
模板开始有主题和分工。

### 新增

- **`--alpha` 透明通道输出** —— 出 ProRes 4444（`.mov`，`yuva444p10le`），文字层能直接叠到
  别人拍的画面上。模板侧写一行 `const TRANSPARENT = !!window.__transparent;`，
  把底色（含全屏光斑、光扫）整块跳过即可。
  体积代价：同一段 2 秒片头 H.264 约 118 KB / ProRes 约 760 KB（约 6.5 倍）。
- **4 个新模板** —— `compare.html`（前后对比）、`flow-steps.html`（流程图动画）、
  `subtitle-card.html`（横屏逐句解说卡）、`vertical-subtitle.html`（竖屏关键词高亮字幕卡）。
  模板总数 6 → 10，四个新模板都过了六维自动验收（运动 / 静止 / 跳变 / 确定性 / 框景 / 报错）。
- **模板主题参数化** —— `assets/templates/themes.js` 提供 `midnight`（暗色，默认）、
  `paper`（浅色，适合文档与教学）、`neon`（黑紫霓虹）三套调色板。
  换主题只改模板里的 `CFG.theme`，不用碰画布代码；传对象可以只覆盖部分字段。
- **`--srt` / `--cues` 外部字幕时间轴** —— 支持 SRT / WebVTT / JSON，解析一次后注入
  `window.__cues`，模板按当前时刻自己查句。实测 4 句 / 80 帧，每句首帧与 SRT 起点的
  偏差 0 ms。没有字幕文件时模板回退到自带的 `CFG.lines`。
- **`--cue-log` 字幕对轴日志** —— 输出 `frame,t,cue_index,cue_start,cue_end` CSV，
  把「字幕时间对不对」变成能算的数，不用靠肉眼看。
- **CHANGELOG 与版本规则** —— 就是这份文件。

### 修复

- **QA 看不见离屏画布里的文字** —— 文字先画进离屏 canvas 再 `drawImage` 贴到主画布时，
  旧版只 hook `fillText` / `strokeText`，看到的是「一块贴图」，半截字完全查不出来。
  现在 `drawImage` 会做坐标映射，把源图上的文字外框追到目标画布。
- **QA 在 DOM 文字上必然误报「叠字」** —— 按文本节点取所有行框的并集时，
  多行段落的并集框会把行内 `<span>` 整个包住，段落和自己的强调词 100% 被判成叠字。
  改为**按视觉行分块**（同一行的片段合并、跨行不合并），同一份 fixture 的框景线索从 6 条降到 1 条
  （剩下那条是真的出界）。
- **竖屏版式散架** —— 横屏的 `SY`（纵向缩放比）在 9:16 下是 1.78，直接拿它算行距会把整栏撑开。
  新增 `VSY = PORTRAIT ? SF : SY` 与竖屏字号档位 `FS`，四个新模板的竖屏版式已按此重排。

### 变更

- **QA 判据抽成可单测的纯函数** —— `frameIssues` / `persistent` / `mergeLines` / `mean` / `median`
  移到 `scripts/lib/qa-rules.cjs`，由 `test/qa-rules.test.mjs` 覆盖。
  页面里跑的和单测跑的是同一个函数体（`mergeLines.toString()` 注入），不会出现两份实现漂移。
- **模板契约测试改成能力登记表** —— 新增模板必须先登记它支持哪些能力（主题 / 字幕 / 透明），
  源码和能力表双向对齐；能力被悄悄删掉、或者新能力没登记，测试都会失败。
- **字幕带**：画面底部 15% 视为平台 UI 区，文字踩进去 QA 会提示「进字幕带」。
  四个新模板的竖屏版式都已避开。

### 已知限制

- **透明输出只有 ProRes 4444，没有 VP9 alpha**。实测把 PNG 序列编成
  `-pix_fmt yuva420p -auto-alt-ref 0`，体积从 7.8 KB 涨到 16.8 KB（alpha 数据确实写进去了），
  但 Chromium 播出来整帧 alpha 全为 0 —— 连文字都透明。lossless / 固定码率 /
  `-lag-in-frames 0` 都一样，ffmpeg 解码也还原不了 webm 的 BlockAdditional alpha。
  所以要透明就用 ProRes，别指望 webm。
- `--gop` 在 `--alpha` 下无效（ProRes 走自己的 GOP 结构），传了会被忽略并告警。

## [1.1.0] - 2026-10-18

### 新增

- **`--resume` 断点续渲** —— 帧原子落盘 + 参数指纹 + 帧号连续性校验。渲到一半断了，
  重跑同一条命令就从断点继续，不用从头再来；参数改过会自动判废、重新开始。
- **工程门面** —— `package.json`、`node --test` 测试套件、GitHub Actions CI、
  `CONTRIBUTING.md`、Issue / PR 模板。
- **首次运行的失败提示写成人话** —— 缺浏览器内核、依赖没装齐时，不再抛一段栈，
  直接告诉你该跑哪条命令。

### 变更

- **模板自适应任意尺寸**：canvas 尺寸跟随视口，换 `--width` / `--height` 不再裁掉右下角。
- **竖屏 9:16 支持**：新增 `vertical-card.html`，并提供一套竖屏版式规则。
- **渲染器尺寸不匹配告警**：HTML 里写死的尺寸和 `--width` / `--height` 不一致时出声，
  避免静默出错片。

## [1.0.0] - 2026-10-12

首个公开版本。

### 新增

- 逐帧渲染管线：HTML / Canvas 写成 `frame(t)`，无头 Chromium 逐帧截图，ffmpeg 编码成 MP4。
- 确定性渲染：同一个 `t` 渲出来的像素完全一致，不依赖实时时钟。
- 6 个内置模板：`title-card`、`bar-chart`、`line-chart`、`number-counter`、`timeline`、
  `vertical-card`。
- 六维自动验收（`scripts/qa.js`）：运动量、最长静止、跳变、确定性、框景线索、页面报错。
- 本地 http server：解锁 ESM 与 `fetch`，避免 `file://` 下的跨域限制。
- 动效库与 GIF 输出。

[未发布]: https://github.com/wx4766/html-to-video/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/wx4766/html-to-video/releases/tag/v1.2.0
[1.1.0]: https://github.com/wx4766/html-to-video/compare/v1.0.0...v1.2.0
[1.0.0]: https://github.com/wx4766/html-to-video/releases/tag/v1.0.0

# html-to-video · 用代码逐帧做视频

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

适合：讲解动画、动态图解、产品演示、数据可视化动画、游戏宣传片。
不适合：实拍感 / 氛围镜头（那个应该走 VideoGen）。

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

# 3. 全量渲染
bash assets/render.sh my-animation.html --duration=12 --fps=60 --width=1920 --height=1080 --concurrency=4
# → my-animation.mp4
```

12 秒 60fps = 720 帧，实测约 6~7 分钟（concurrency=4）。

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

**画布就是唯一输出**：`<canvas>` 定位在 `left:0; top:0`，body `margin:0`。
渲染器截左上角，画布必须正好铺满视口、**不能居中**。

**别用这些 class 名**（渲染器注入的 CSS 会无条件隐藏它们，元素会凭空消失）：

```
.no-record .progress .progress-bar .counter .tCur .phases .phase-label
.phase .replay .masthead .kicker .title .footer
```

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
不会。渲染器会保留 `.seek-tmp-*/` 里的全部 PNG，修好后手动编码即可，不必重截：

```bash
"$FF" -y -framerate 60 -i .seek-tmp-*/frame-%06d.png -c:v libx264 -pix_fmt yuv420p \
  -crf 18 -preset medium -r 60 -movflags +faststart animation.mp4
```

## 目录结构

```
html-to-video/
├── SKILL.md                       技能说明（WorkBuddy 读取）
├── scripts/
│   ├── render-video-seek.js       渲染器内核：冻结时钟 + 逐帧 seek 截图 + ffmpeg 编码
│   ├── detect-env.js              探测浏览器缓存，输出该装哪个 playwright 版本
│   └── install-deps.sh            一键装依赖并写配置
└── assets/
    ├── render.sh                  全量渲染包装器
    ├── smoke.sh / smoke.cjs       冒烟测试：验证契约 + 试截关键帧
    └── animation-skeleton.html    动画骨架模板（已实现完整渲染契约）
```

## License

MIT

# 贡献指南

先说清楚这个项目**最需要什么**，省得白花力气：

| 优先级 | 需要 | 说明 |
|---|---|---|
| 高 | **新模板** | 逐句解说卡、前后对比图、流程图动画…… 短视频场景很缺 |
| 高 | **Bug 报告**（带复现命令） | 尤其是「渲出来和预期不一样」这类，报告里附 `qa/qa.md` 最有价值 |
| 中 | 文档改进 | 新手最常卡在哪一步，写清楚就是贡献 |
| 中 | 判据的误报/漏报案例 | 你手上那段"明明没问题却报错"的片子，就是最好的样本 |
| 低 | 重构 | 这个项目代码量不大，可读性优先于抽象 |

**不需要**先开 issue 问能不能做 —— 直接提 PR 更快，只要下面几条做到。

---

## 1. 环境

```bash
git clone https://github.com/wx4766/html-to-video.git
cd html-to-video

# 方式 A：一条命令装好渲染依赖（playwright + 完整版 ffmpeg）
bash scripts/install-deps.sh

# 方式 B：自己来
npm install
npx playwright install chromium
# 并且确保 ffmpeg 在 PATH 里，或设置 FFMPEG=/abs/path/to/ffmpeg
```

**ffmpeg 必须是完整版**（带 `libx264`）。Playwright 自带那个是裁剪版，编不了 H.264：

```bash
ffmpeg -hide_banner -encoders | grep libx264    # 有输出才算对
```

Node 要求 `>= 18`（`package.json` 的 `engines` 会拦）。

## 2. 跑测试

```bash
npm test
```

测试分两类，加起来约 1 分钟：

| 文件 | 验什么 |
|---|---|
| `test/render-smoke.test.mjs` | 真渲两段（16:9 与 9:16），验成片分辨率、文件大小、不能有尺寸告警 |
| `test/qa-clean.test.mjs` | 正常模板必须 PASS（确定性 ✓ / 框景 0 / 报错 0） |
| `test/qa-detects.test.mjs` | **对照组**：`test/fixtures/broken.html` 里故意注入六类缺陷，检测器必须叫出来并判失败 |
| `test/templates-contract.test.mjs` | 每个模板是否遵守渲染契约（不写死画布尺寸、暴露 `__seek` 等） |

`qa-clean` 和 `qa-detects` 是**成对的**：一个防误报，一个防漏报。改动 `scripts/qa.js` 的判据时，
两边都得绿 —— 只调松不放对照组，等于把质量门拆了。

## 3. 加一个模板

模板是**单文件自包含**的（不引用外部 js/css），照 `assets/templates/title-card.html` 抄骨架。
四条硬约定：

**① 渲染契约**（这段原样保留，别改）

```js
window.__seek = renderAt;      // 外部按时刻推帧
window.__ready = true;         // 宣告就绪
if (window.__seekRender) {     // 录制模式：冻结时钟，完全由 __seek 驱动
  renderAt(0);
}
```

**② 画布跟随视口**（写死尺寸会在换分辨率时静默裁掉右下角）

```js
const W = window.innerWidth, H = window.innerHeight;
cv.width = W; cv.height = H;
const SX = W / 1920, SY = H / 1080, SF = Math.sqrt(SX * SY);   // 横向 / 纵向 / 字号
```

`SF = √(SX·SY)` 是刻意的：1920×1080 下三者都为 1，所以原有输出不变；
换成竖屏时字号不缩、版式铺开。字号、线宽、圆角都乘 `SF`，坐标乘 `SX` 或 `SY`。

**③ 字幕安全区**：文字不落在画面底部 15%（烧录字幕后会被盖住）。

**④ 别「定格待读」太久**：连续静止超 3 秒 QA 会提示。加一条极淡的环境光扫（模板里都有）。

**⑤ 超长文字要收**：标题/数值用 `measureText` 量一下，超宽就等比缩字号 ——
不要指望用户填的字刚好放得下。

做完跑六维验收：

```bash
bash assets/qa.sh assets/templates/你的模板.html --duration=6 --fps=30
```

要求：**框景 0、页面报错 0、确定性 ✓**。跳变和静止时长是提示，不是错误，
但要在 PR 里说明为什么可以接受。

## 4. 提 PR

PR 描述里请写清三件事：

1. **改了什么、为什么**（一句话能说清最好）
2. **怎么验证的** —— 贴 `qa/qa.md` 的指标行，或渲染命令 + 截图
3. **会不会影响已有输出** —— 改了模板/渲染器的话，16:9 的成片是否仍然逐像素一致

> 关于第 3 点：改模板时我们习惯用「改前存静帧 → 改后同帧对比」的 PSNR 回归，
> 一致时 ffmpeg 会输出 `average:inf`。这个习惯救过好几次"看起来没变其实变了"。

CI 会在 PR 上自动跑 `npm test`，绿了才会被合。

## 5. 报告 Bug

用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.yml)，里面要的几样东西真的有用：

- **完整命令**（含所有参数）
- **`qa/qa.md`**（如果有）—— 比贴 20 张截图有用
- 环境：OS、`node -v`、`ffmpeg -version` 第一行、`npx playwright --version`
- 期望 vs 实际

## 6. 代码风格

- 注释写**为什么**，不写**是什么** —— 代码本身已经说明是什么了
- 报错信息要能指导下一步动作（"画面尺寸和视口对不上，改 cv.width = window.innerWidth"），
  不要只抛 `Error: failed`
- 中文注释可以，术语保留英文（`seek` / `rAF` / `yuv420p`）

## 7. 许可

提交 PR 即表示你同意以 [MIT](LICENSE) 许可发布你的贡献。

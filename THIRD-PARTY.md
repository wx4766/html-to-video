# 第三方代码与思路归属

本项目主体为 MIT（见 `LICENSE`）。下列外部项目的思想、词汇表或算法被借鉴，
按各自许可证在此致谢。**均为独立重写**（针对 Canvas 2D 重新实现），不含对方的代码文件。

---

## cinecode

- 仓库：https://github.com/sarpstar/cinecode
- 许可证：MIT
- 用在哪：`assets/lib/camera.js` 的**第二层「镜头语言」**、`scripts/qc.js` 的检查项与阈值思路、
  `scripts/audio-master.js` 的两遍 `loudnorm` 线性归一流程、`references/writing.md` 的写作规则。

借鉴的具体内容：

| 本项目 | 借鉴自 cinecode | 重写方式 |
|---|---|---|
| 12 个命名运动（dolly in / pan / crane / orbit / dolly zoom / whip / rack focus …）与其「感觉到什么」的描述 | `camera-moves.md`、`camera.mjs` | 词表与手感一致；运动输出改为 Canvas 2D 的 `{scale, tx, ty, rot, blur}` 变换，位移用比例单位，新增防露边裁剪 |
| `inertia` 缓动（0.35 linear + 0.65 smoothstep） | `camera.mjs` | 直接采用同一条曲线（数学式本身不受版权保护），并在测试里固定了两端速度不为零的性质 |
| 成片质检项：hook / 黑场 / 冻结 / 重复帧 / 响度 / 联系表 | `qc.py` | 只用 ffmpeg 重写，去掉 ffprobe 依赖，阈值按本地实测基线重定 |
| 两遍 `loudnorm`、`type=linear` 校验、AAC 真峰值余量、`level=false` | `master_audio.py` | 重写为 Node CLI，加限幅后重新测量的修正 |
| 写作规则：分叉收敛、六种转折、caption test、字数预算、陈词滥调 | `writing.md` | 中文重写并换成中文语境的例子与清单 |

### 风格配方方法论（经 cinecode 收录）

`references/style-recipe.md` 的十一章骨架来自 **lemo-opuscar** 的风格配方
（https://github.com/lemomo-ai/lemo-opuscar ，MIT，作者 LemoLab），cinecode 收录了其中 51 份
并另写 7 份，共 58 份。本项目：

- 只取**章节骨架**（本质/材料/色彩/字体/运动/运镜/声音/招牌动作/介质陷阱/实现映射/可变空间）；
- 每一章重写为「落到本项目的哪个钩子、写到什么颗粒度」，并补充查风格的五问与本项目陷阱清单；
- **没有复制任何一份配方正文**，58 份原文一份都没进本仓库；
- 分类法（8 个 base 家族的思路）借用了，收敛成本项目能用的 5 类。

风格条目本身（玻璃拟态、木刻版画）是本项目按自己的 7 个钩子独立实现的 Canvas 2D 代码，
不是从配方翻译。

`watercolor` 的飞白修正直接来自该配方第 2 章对刷毛轨迹的描述（3–9 条、30–85% 不透明度、
随机断点）——这是**技术事实**，不是表达，但出处记在这里。

cinecode 的 MIT 声明原文：

```
MIT License

Copyright (c) 2026 Sarp Yıldız

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 依赖

运行期依赖只有两个，都是间接依赖、不打包进产物：

| 包 | 许可证 | 用途 |
|---|---|---|
| `playwright`（`playwright-core`） | Apache-2.0 | 无头浏览器逐帧截图 |
| `@ffmpeg-installer/ffmpeg` | LGPL/GPL（ffmpeg 本体） | 编码；也可以改用系统 ffmpeg |

本项目不分发 ffmpeg 二进制，只声明它的路径；商业分发时请自行确认 ffmpeg 的构建选项
（含 libx264 的构建通常是 GPL）。

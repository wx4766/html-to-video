/**
 * 冒烟用例 ④：模板契约静态检查（不开浏览器，秒级）。
 *
 * 模板最容易被改坏的地方不是动画，是「渲染契约」—— 少暴露一个 __seek、
 * 把 canvas 尺寸写死，都会让出片静默出错。这里把约定变成断言。
 *
 * 第二个坑是「能力悄悄消失」：某个模板本来支持 --alpha / --srt / 主题，
 * 后来有人重构把它删了，肉眼看不出来，直到用户叠透明层时才发现是白底。
 * 所以下面维护一张能力登记表（CAPS）：
 *   · 表里有、源码里没有 → 报错（能力被删了）
 *   · 源码里有、表里没有 → 报错（新能力没登记，别人不知道）
 * 双向都要对上，模板才不会「看起来都还在」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATES } from '../scripts/lib/testing.mjs';

/* =====================================================================
   能力登记表 —— 加模板 / 加能力都从这里改，测试会逼着你两边对齐
   ---------------------------------------------------------------------
   theme : 读 CFG.theme + h2vTheme()，即支持换主题（依赖同目录 themes.js）
   cues  : 读 window.__cues，即支持 --srt 外部时间轴覆盖 CFG.lines
   alpha : 读 window.__transparent，即支持 --alpha 透明输出

   v1.4.0 起 11 个模板全部支持 theme；alpha 仍只给「满版图表之外」的模板 ——
   折线 / 条形 / 大数字 / 时间线是要底色的图表，透明了反而没法用。
   ===================================================================== */
const CAPS = {
  'bar-chart.html':         { theme: true,  cues: false, alpha: false },
  'compare.html':           { theme: true,  cues: false, alpha: true  },
  'explainer.html':         { theme: true,  cues: true,  alpha: true  },
  'flow-steps.html':        { theme: true,  cues: false, alpha: true  },
  'line-chart.html':        { theme: true,  cues: false, alpha: false },
  'number-counter.html':    { theme: true,  cues: false, alpha: false },
  'subtitle-card.html':     { theme: true,  cues: true,  alpha: true  },
  'timeline.html':          { theme: true,  cues: false, alpha: false },
  'title-card.html':        { theme: true,  cues: false, alpha: true  },
  'vertical-card.html':     { theme: true,  cues: false, alpha: false },
  'vertical-subtitle.html': { theme: true,  cues: true,  alpha: true  },
};

/** themes.js 是共用脚本，不是模板，单独校验 */
const SHARED = new Set(['themes.js']);

const allFiles = fs.readdirSync(TEMPLATES).sort();
const templates = allFiles.filter((f) => f.endsWith('.html'));

const read = (f) => fs.readFileSync(path.join(TEMPLATES, f), 'utf8');

/** 去掉行注释里的示例，避免「注释里提到但代码里没写」骗过断言 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ===================================================================== */

test('模板清单与能力登记表完全一致', () => {
  const onDisk = new Set(templates);
  const inTable = new Set(Object.keys(CAPS));

  const missing = [...onDisk].filter((f) => !inTable.has(f));
  const extra = [...inTable].filter((f) => !onDisk.has(f));

  assert.deepEqual(
    missing, [],
    `新增模板必须先在 test/templates-contract.test.mjs 的 CAPS 里登记能力：${missing.join(', ')}`
  );
  assert.deepEqual(
    extra, [],
    `登记表里有、磁盘上没有（模板被删或改名了）：${extra.join(', ')}`
  );
  assert.ok(templates.length >= 10, `模板数量不该缩水，至少 10 个，实际 ${templates.length} 个`);
});

/** 模板目录里用相对路径引用的脚本，必须真的存在 —— 少个文件就是白屏 */
test('模板引用的同目录脚本都存在', () => {
  const broken = [];
  for (const f of templates) {
    const code = stripComments(read(f));
    for (const m of code.matchAll(/<script[^>]+src\s*=\s*["']\.\/([^"']+)["']/g)) {
      if (!fs.existsSync(path.join(TEMPLATES, m[1]))) broken.push(`${f} → ./${m[1]}`);
    }
    // ../lib/*.js 是素材库（motion / scenes / camera / shapes / figures），
    // 拷模板时最容易漏，同样要查
    for (const m of code.matchAll(/<script[^>]+src\s*=\s*["']\.\.\/lib\/([^"']+)["']/g)) {
      const p = path.resolve(TEMPLATES, '..', 'lib', m[1]);
      if (!fs.existsSync(p)) broken.push(`${f} → ../lib/${m[1]}`);
    }
  }
  assert.deepEqual(broken, [], `引用了不存在的脚本：\n${broken.join('\n')}`);
});

/** 素材库是多个模板共用的公共资产，缺一个就会有一批模板白屏 */
test('素材库文件齐全（motion / scenes / camera / shapes / figures）', () => {
  const LIB = path.resolve(TEMPLATES, '..', 'lib');
  const need = [
    ['motion.js', 'MO'], ['scenes.js', 'SC'], ['camera.js', 'CAM'],
    ['shapes.js', 'SH'], ['figures.js', 'FIG'],
  ];
  const missing = [];
  for (const [file, globalName] of need) {
    const p = path.join(LIB, file);
    if (!fs.existsSync(p)) { missing.push(file + '（文件不存在）'); continue; }
    const src = fs.readFileSync(p, 'utf8');
    if (!src.includes(`root.${globalName} = ${globalName}`)) missing.push(`${file} 没导出 ${globalName}`);
    if (!src.includes('module.exports')) missing.push(`${file} 没导出 module.exports（测试没法单测）`);
  }
  assert.deepEqual(missing, [], `素材库有问题：\n${missing.join('\n')}`);
});

/* ---------------------------- 基础契约 ---------------------------- */

for (const file of templates) {
  test(`模板契约：${file}`, () => {
    const src = read(file);
    const code = stripComments(src);

    assert.match(code, /window\.__seek\s*=/, '必须暴露 window.__seek');
    assert.match(code, /window\.__ready\s*=\s*true/, '必须设置 window.__ready = true');
    assert.match(code, /__seekRender/, '必须处理冻结时钟（window.__seekRender）');
    assert.match(code, /const CFG\s*=\s*\{/, '顶部应有 CFG 配置块，方便改文案');

    /* 尺寸自适应：写死 canvas 宽高 → 换 --width/--height 会静默裁掉右下角 */
    assert.doesNotMatch(src, /<canvas[^>]*\bwidth\s*=\s*"\d+"/, 'canvas 不该写死宽度（应跟随视口）');
    assert.doesNotMatch(src, /<canvas[^>]*\bheight\s*=\s*"\d+"/, 'canvas 不该写死高度（应跟随视口）');
    assert.match(code, /window\.innerWidth/, '画布宽度应取 window.innerWidth');
    assert.match(code, /window\.innerHeight/, '画布高度应取 window.innerHeight');
  });
}

/* ------------------------- 能力契约（双向） ------------------------- */

for (const file of templates) {
  const caps = CAPS[file];

  test(`能力契约：${file}`, () => {
    const src = read(file);
    const code = stripComments(src);

    /* --- 主题 --- */
    const loadsThemes = /<script[^>]+src\s*=\s*["']\.\/themes\.js["']/.test(src);
    const callsTheme = /h2vTheme\s*\(/.test(code);
    assert.equal(
      loadsThemes, caps.theme,
      caps.theme
        ? '登记了支持主题，但没有 <script src="./themes.js">'
        : '没有登记主题能力，却引入了 themes.js（要么登记，要么删掉）'
    );
    assert.equal(callsTheme, caps.theme, caps.theme ? '必须调用 h2vTheme()' : '不该调用 h2vTheme()');
    if (caps.theme) {
      assert.match(code, /theme\s*:/, 'CFG 里应有 theme 字段，换主题只改这一处');
      /* 主题脚本可能加载失败（用户拷走单个 HTML），必须能优雅降级 */
      assert.match(
        code, /window\.h2vTheme\s*\?/,
        'h2vTheme 要带存在性判断（window.h2vTheme ? ... : 兜底色板），否则 themes.js 缺失时白屏'
      );
      /* 渲染器 --theme 靠注入 window.__h2vTheme 生效；不读它，命令行换主题就是空操作 */
      assert.match(
        code, /__h2vTheme/,
        '登记了主题能力，就必须读 window.__h2vTheme —— 否则 --theme=paper 不生效'
      );
    }

    /* --- 字幕时间轴 --- */
    const readsCues = /window\.__cues/.test(code);
    assert.equal(
      readsCues, caps.cues,
      caps.cues
        ? '登记了支持 --srt，但没有读取 window.__cues'
        : '没有登记字幕能力，却读取 window.__cues'
    );
    if (caps.cues) {
      assert.match(code, /CFG\.lines/, '必须保留 CFG.lines 兜底：没有 --srt 时也要能自己跑');
    }

    /* --- 透明输出 --- */
    const readsTransparent = /window\.__transparent/.test(code);
    assert.equal(
      readsTransparent, caps.alpha,
      caps.alpha
        ? '登记了支持 --alpha，但没有读取 window.__transparent（渲出来会是白底）'
        : '没有登记透明能力，却读取 window.__transparent'
    );
    if (caps.alpha) {
      /* 只跳过底色、留着全屏光斑 → 四角 alpha=12，叠实拍会整片泛白。必须有条件分支。 */
      assert.match(
        code, /if\s*\(\s*!?\s*TRANSPARENT\s*\)/,
        '透明模式要用 if (!TRANSPARENT) 把整块底色（含光斑/光扫）一起跳过'
      );
    }
  });
}

/* --------------------------- themes.js --------------------------- */

test('主题文件：三套内置主题 + 字段齐全 + 兜底逻辑', () => {
  const file = path.join(TEMPLATES, 'themes.js');
  assert.ok(fs.existsSync(file), 'themes.js 必须存在（4 个模板依赖它）');

  const src = fs.readFileSync(file, 'utf8');

  assert.match(src, /window\.H2V_THEMES\s*=/, '必须导出 window.H2V_THEMES');
  assert.match(src, /window\.h2vTheme\s*=\s*function/, '必须导出 window.h2vTheme(name)');

  /* 名字写死在测试里：改名字不算重命名，算破坏兼容 */
  for (const name of ['midnight', 'paper', 'neon']) {
    assert.match(src, new RegExp(`${name}\\s*:`), `内置主题应包含 ${name}`);
  }

  /* 文档里承诺的字段，一个都不能少 —— 模板会直接取 T.xxx，缺了就是 undefined 色值 */
  const FIELDS = [
    'bg', 'bgAlt', 'ink', 'sub', 'faint',
    'panel', 'accent', 'accent2', 'good', 'bad', 'glow',
  ];

  /* 可选字段：只给非默认主题补。
     midnight 一律不填 —— 模板写成 `TH.accentDeep || '<历史常量>'`，
     默认主题于是继续走原常量，逐像素不变；换主题时才用新色。
     这条规则是「加主题能力」不背「默认画面偷偷变了」的债，所以要在测试里钉住。 */
  const OPTIONAL = ['bgFar', 'accentDeep', 'accentSoft', 'sweep', 'onAccent'];

  const blocks = src.split(/const\s+[A-Z]+\s*=\s*\{/).slice(1);
  assert.ok(blocks.length >= 3, `应能切出至少 3 套主题定义，实际 ${blocks.length} 套`);
  blocks.forEach((block, i) => {
    const body = block.slice(0, block.indexOf('};') + 1);
    for (const f of FIELDS) {
      assert.match(body, new RegExp(`\\b${f}\\s*:`), `第 ${i + 1} 套主题缺字段 ${f}`);
    }
    for (const f of OPTIONAL) {
      const has = new RegExp(`\\b${f}\\s*:`).test(body);
      if (i === 0) {
        assert.equal(
          has, false,
          `midnight 不该定义可选字段 ${f}：模板里用 TH.${f} || 历史常量 兜底，` +
          '填了反而会让默认输出跟着变'
        );
      } else {
        assert.ok(
          has,
          `第 ${i + 1} 套主题缺可选字段 ${f} —— 换到这套主题时会退化成模板里的深色常量，浅底上可能看不清`
        );
      }
    }
  });

  /* 模板靠 h2vRgba 取「同一主题色的不同透明度」，缺了就得每处自己拆 hex */
  assert.match(src, /window\.h2vRgba\s*=\s*function/, '必须导出 window.h2vRgba(hex, alpha)');
  /* 渲染器 --theme 的回读靠它：名字打错要能发现，而不是静默回退 */
  assert.match(src, /__h2vThemeResolved/, '必须记录实际生效的主题名（供渲染器回读校验）');

  /* 未知名回退 midnight、对象原样合并 —— 这两条是文档写明的行为 */
  assert.match(src, /H2V_THEMES\[name\]\s*\|\|\s*MIDNIGHT/, '未知主题名应回退 midnight');
  assert.match(src, /typeof name\s*===\s*'object'/, 'CFG.theme 传对象时应直接合并');
});

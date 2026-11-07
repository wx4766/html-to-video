#!/usr/bin/env node
/**
 * h2v · 统一命令入口
 * ---------------------------------------------------------------------------
 * 这套工具原本是"一堆脚本"：render-video-seek.js / beats.js / storyboard.js / qa.js。
 * 对 Agent 来说无所谓（它读文档、拼路径），但对人来说第一步就卡住 ——
 * 「我该跑哪个脚本？参数怎么传？路径是相对谁？」
 *
 * 所以加一层 30 行的壳：把子命令映射到脚本，参数原样透传，退出码原样返回。
 * 它不实现任何逻辑，也不改默认行为 —— `h2v render x.html` 和直接跑
 * `node scripts/render-video-seek.js x.html` 完全等价。
 *
 * 用法：
 *   npx html-to-video render demo.html --duration=6 --fps=60
 *   npx html-to-video beats bgm.mp3 --out=beats.json
 *   npx html-to-video preview demo.html --duration=6 --open
 *   npx html-to-video storyboard demo.html --duration=24
 *   npx html-to-video doctor
 *   npx html-to-video styles            # 列出 12 种视觉风格
 *   npx html-to-video templates         # 列出 14 个版式模板
 *   npx html-to-video new my-video      # 拷一个模板出来改
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const cmd = argv[0];

function run(script, args, opts) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    stdio: 'inherit', env: process.env, cwd: (opts && opts.cwd) || process.cwd(),
  });
  process.exit(r.status == null ? 1 : r.status);
}

function version() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch (e) { return '?'; }
}

function usage() {
  console.log(`
html-to-video v${version()} · 用代码逐帧做视频

  h2v render <file.html> [选项]      渲染成 MP4（最常用）
  h2v preview <file.html> [选项]     浏览器里拖时间轴预览（不用等渲染）
  h2v beats <audio> [选项]           分析 BPM / 拍点，产出 beats.json
  h2v storyboard <file.html> [选项]  先出一页分镜板，再决定要不要渲全片
  h2v doctor                         环境自检（缺什么、怎么修）
  h2v styles                         列出视觉风格（--theme= 的值）
  h2v templates                      列出模板（可直接改字出片）
  h2v new <名字> [--template=xxx]    把模板拷到当前目录

常用渲染参数：
  --duration=6 --fps=60 --width=1920 --height=1080
  --theme=ink            换视觉语言（12 种，见 h2v styles）
  --preset=douyin        按平台定尺寸；--presets=douyin,xiaohongshu 出全套
  --audio=bgm.mp3 --beats --snap=beats    自动卡点
  --story=shots.json     用 JSON 换掉整份镜头表
  --json                 给 Agent 用：stdout 只有一行结果 JSON

文档：README.md（中文）· SKILL.md（给 Agent 的契约与踩坑清单）· assets/STYLES.md
`);
}

switch (cmd) {
  case 'render': case 'r':
    if (!argv[1]) { usage(); process.exit(1); }
    run('render-video-seek.js', argv.slice(1));
    break;

  case 'preview': case 'p':
    if (!argv[1]) { usage(); process.exit(1); }
    run('preview.js', argv.slice(1));
    break;

  case 'beats': case 'b':
    if (!argv[1]) { usage(); process.exit(1); }
    run('beats.js', argv.slice(1));
    break;

  case 'storyboard': case 's':
    if (!argv[1]) { usage(); process.exit(1); }
    run('storyboard.js', argv.slice(1));
    break;

  case 'doctor':
    run('doctor.js', argv.slice(1));
    break;

  case 'styles': {
    // 只读注册表，不画图 —— 所以 node 里也能列（不需要 document）
    const SV = require(path.join(ROOT, 'assets', 'lib', 'styles.js'));
    console.log('\n视觉风格（--theme=<id> 或中文名都行）：\n');
    for (const s of SV.list()) {
      console.log(`  ${s.id.padEnd(12)} ${s.cn.padEnd(8)} ${s.en.padEnd(16)} ${s.tags.join(' / ')}`);
    }
    console.log('\n挑风格：node scripts/render-video-seek.js assets/style-gallery.html --stills=0.5,1.5,...');
    console.log('细节：assets/STYLES.md\n');
    break;
  }

  case 'templates': {
    const dir = path.join(ROOT, 'assets', 'templates');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
    console.log('\n版式模板（拷一个改 CFG 就能出片）：\n');
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = /<title>模板\s*·\s*([^<]+)<\/title>/.exec(src);
      console.log(`  ${f.padEnd(24)} ${m ? m[1].trim() : ''}`);
    }
    console.log('\n拿一个出来改：h2v new my-video --template=title-card\n');
    break;
  }

  case 'new': {
    const name = argv[1];
    if (!name) { usage(); process.exit(1); }
    const tArg = argv.find((a) => a.startsWith('--template='));
    const tpl = tArg ? tArg.split('=')[1] : 'title-card';
    const srcDir = path.join(ROOT, 'assets', 'templates');
    const srcFile = path.join(srcDir, tpl.endsWith('.html') ? tpl : tpl + '.html');
    if (!fs.existsSync(srcFile)) {
      console.error(`✗ 没有这个模板：${tpl}`);
      console.error('  可用：' + fs.readdirSync(srcDir).filter((f) => f.endsWith('.html')).join(' / '));
      process.exit(1);
    }
    const outName = name.endsWith('.html') ? name : name + '.html';
    const out = path.resolve(process.cwd(), outName);
    if (fs.existsSync(out)) {
      console.error(`✗ 目标已存在，不覆盖：${out}`);
      process.exit(1);
    }
    fs.copyFileSync(srcFile, out);

    /* themes.js 是模板的同目录依赖，必须一起拷 —— 只拷 HTML 会 404，
       而渲染器把"页面报错"判为失败，用户看到的是"渲染失败"，很难联想到少文件。 */
    const themes = path.join(srcDir, 'themes.js');
    const outThemes = path.join(path.dirname(out), 'themes.js');
    if (!fs.existsSync(outThemes)) fs.copyFileSync(themes, outThemes);

    console.log(`✓ 已创建 ${outName}（来自 ${tpl}）`);
    console.log(`  同目录一起拷了 themes.js（换配色要用）`);
    console.log(`  下一步：改文件顶部的 CFG，然后  h2v preview ${outName} --duration=6`);
    break;
  }

  case 'version': case '-v': case '--version':
    console.log(version());
    break;

  case undefined: case 'help': case '-h': case '--help':
    usage();
    break;

  default:
    console.error(`✗ 不认识的命令：${cmd}`);
    usage();
    process.exit(1);
}

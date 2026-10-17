/**
 * 冒烟用例 ④：模板契约静态检查（不开浏览器，秒级）。
 *
 * 模板最容易被改坏的地方不是动画，是「渲染契约」—— 少暴露一个 __seek、
 * 把 canvas 尺寸写死，都会让出片静默出错。这里把约定变成断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATES } from '../scripts/lib/testing.mjs';

const templates = fs.readdirSync(TEMPLATES).filter((f) => f.endsWith('.html')).sort();

test('模板目录非空', () => {
  assert.ok(templates.length >= 6, `至少应有 6 个模板，实际 ${templates.length} 个`);
});

for (const file of templates) {
  test(`模板契约：${file}`, () => {
    const src = fs.readFileSync(path.join(TEMPLATES, file), 'utf8');

    assert.match(src, /window\.__seek\s*=/, '必须暴露 window.__seek');
    assert.match(src, /window\.__ready\s*=\s*true/, '必须设置 window.__ready = true');
    assert.match(src, /__seekRender/, '必须处理冻结时钟（window.__seekRender）');
    assert.match(src, /const CFG\s*=\s*\{/, '顶部应有 CFG 配置块，方便改文案');

    /* 尺寸自适应：写死 canvas 宽高 → 换 --width/--height 会静默裁掉右下角 */
    assert.doesNotMatch(src, /<canvas[^>]*\bwidth\s*=\s*"\d+"/, 'canvas 不该写死宽度（应跟随视口）');
    assert.doesNotMatch(src, /<canvas[^>]*\bheight\s*=\s*"\d+"/, 'canvas 不该写死高度（应跟随视口）');
    assert.match(src, /window\.innerWidth/, '画布宽度应取 window.innerWidth');
    assert.match(src, /window\.innerHeight/, '画布高度应取 window.innerHeight');
  });
}

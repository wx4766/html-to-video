/**
 * 本地静态服务器（渲染 / 验收都用它加载页面）的端口安全回归。
 *
 * 背景：Chromium 拒绝访问一批「不安全端口」，导航直接报
 *   net::ERR_UNSAFE_PORT at http://127.0.0.1:3659/...
 * 我们让系统随机分端口（listen(0)），撞上名单就渲染失败，而报错完全指不到端口分配。
 * 3659 是实测撞到过的那个。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startServer, isUnsafePort, UNSAFE_PORTS } = require('../scripts/lib/local-server.cjs');

test('不安全端口名单认得 Chromium 拦的那些', () => {
  for (const p of [3659, 10080, 6667, 6669, 22, 25]) {
    assert.equal(isUnsafePort(p), true, `${p} 应该被判为不安全`);
  }
  for (const p of [3000, 5173, 8080, 45123]) {
    assert.equal(isUnsafePort(p), false, `${p} 不该被判为不安全`);
  }
  assert.ok(UNSAFE_PORTS.size >= 70, `名单太小，可能漏了：${UNSAFE_PORTS.size}`);
});

test('startServer 分到的端口一定在 Chromium 白名单内', async () => {
  const srv = await startServer();
  try {
    assert.ok(srv.port > 0);
    assert.equal(isUnsafePort(srv.port), false, `分到了不安全端口 ${srv.port}`);
    assert.match(srv.url('C:/tmp/a.html'), /^http:\/\/127\.0\.0\.1:\d+\/C%3A\/tmp\/a\.html$/);
  } finally {
    await srv.close();
  }
});

test('连续起 5 个服务器，端口互不冲突且都安全', async () => {
  const list = [];
  for (let i = 0; i < 5; i++) list.push(await startServer());
  try {
    const ports = list.map((s) => s.port);
    assert.equal(new Set(ports).size, ports.length, `端口重复：${ports.join(',')}`);
    for (const p of ports) assert.equal(isUnsafePort(p), false, `不安全端口 ${p}`);
  } finally {
    await Promise.all(list.map((s) => s.close()));
  }
});

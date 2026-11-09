'use strict';
/* ============================================================
 * T18 · 静态体验站 shim 引擎黄金对账测试
 * 用法：node mvp/tools/test-demo-shim.node.js
 *
 * 方法：随机端口 require mvp/server/index.js 起真实服务；require docs/demo/api-shim.js
 * （global.window={} + global.fetch 桩）取本地引擎 QE；对同一 DSL 分别打真实 HTTP 与
 * 本地引擎，断言 6 组黄金查询一致（数值容差 0.05）：
 *   ① 全国按省 GDP（含 yoy）
 *   ② 江苏省按市（descendantOf 下钻）
 *   ③ 制造业（industry_c1=in C）构成（industry_c2 粒度）
 *   ④ 累计指标请求 mom → 403 COMPARE_POLICY_FORBIDDEN
 *   ⑤ prov-js 查全国 → rlsApplied 且值=江苏口径（与 leader 的江苏行一致）
 *   ⑥ 时间范围过滤（filters.time_range 子区间）
 * 全部 6/6 PASS 才算通过。
 * ============================================================ */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');            // D:\local\visual
const DEMO_DATA = path.join(ROOT, 'docs', 'demo', 'data');
const TOL = 0.05;

/* ---- ① 保留 Node 原生 fetch（打真实 HTTP 用），再装 shim 桩 ---- */
const realFetch = global.fetch;
if (!realFetch) {
  console.error('[FATAL] 需要 Node >= 18（内置 fetch）');
  process.exit(2);
}

/* ---- ② shim 环境桩：window={} + fetch 桩（shim 走 module.exports 取 QE） ---- */
global.window = {};
// 安全：数据文件路径全部预构建自常量（查找表），运行时零路径拼接、零变量输入
const DATA_FILES = {
  'metrics.json': path.join(DEMO_DATA, 'metrics.json'),
  'dims.json': path.join(DEMO_DATA, 'dims.json'),
  'roles.json': path.join(DEMO_DATA, 'roles.json'),
  'dashboards.json': path.join(DEMO_DATA, 'dashboards.json'),
  'facts-lite.json': path.join(DEMO_DATA, 'facts-lite.json'),
};
global.fetch = async (url) => {
  // 桩仅服务 shim 自加载场景（本测试直接 QE.init，不依赖）；按 basename 查表
  const base = String(url).split(/[?#]/)[0].split('/').pop();
  const file = DATA_FILES[base];
  if (!file) return { ok: false, status: 404, text: async () => 'forbidden basename' };
  return { ok: true, status: 200, text: async () => fs.readFileSync(file, 'utf8') };
};
// 安全：静态字面量路径 require（消除动态路径进模块加载器的模式）
const QE = require('../../docs/demo/api-shim.js');

/* ---- ③ QE 初始化：喂 docs/demo/data（体验站实际发布的数据文件） ---- */
const rd = (p) => JSON.parse(fs.readFileSync(path.join(DEMO_DATA, p), 'utf8'));
const initInfo = QE.init({
  metricsDoc: rd('metrics.json'),
  dimsDoc: rd('dims.json'),
  rolesDoc: rd('roles.json'),
  dashboardsDoc: rd('dashboards.json'),
  factsLite: rd('facts-lite.json'),
});

/* ---- ④ 起真实服务（随机端口） ---- */
// 安全：静态字面量路径 require（消除动态路径进模块加载器的模式）
const { startServer } = require('../server/index.js');

/* ============ 断言工具 ============ */
let passed = 0, failed = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; failures.push(label + (extra ? ' | ' + extra : '')); console.log('  FAIL  ' + label + (extra ? ' | ' + extra : '')); }
}

/** 深度一致（数值容差 TOL；对象键集合须一致；null 同 null） */
function close(a, b, tol = TOL) {
  if (a === null || a === undefined) return (b === null || b === undefined);
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => close(v, b[i], tol));
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => ka[i] === kb[i])) return false;
    return ka.every((k) => close(a[k], b[k], tol));
  }
  return a === b;
}

/** 本地引擎应答（直接走 QE.query，与浏览器拦截层同一入口） */
function localQuery(dsl, role) { return QE.query(dsl, role); }

/** 真实 HTTP 应答 */
async function httpQuery(base, dsl, role) {
  const resp = await realFetch(base + '/api/v1/query', {
    method: 'POST',
    headers: { 'X-Role': role, 'Content-Type': 'application/json' },
    body: JSON.stringify(dsl),
  });
  const json = await resp.json();
  return { status: resp.status, body: json };
}

/** 黄金对账：status + data + meta 关键字段（sql/appliedFilters/rlsApplied/rows/truncated） */
function assertSame(label, dsl, role, real, local) {
  ok(real.status === local.status, label + ' · status', `real=${real.status} local=${local.status}`);
  if (real.status !== 200 || local.status !== 200) {
    ok(!!(real.body.error && local.body.error), label + ' · 双侧均返回 error 对象');
    ok(real.body.error && local.body.error && real.body.error.code === local.body.error.code,
      label + ' · error.code', `real=${real.body.error && real.body.error.code} local=${local.body.error && local.body.error.code}`);
    return;
  }
  const rd_ = real.body.data, ld = local.body.data;
  ok(Array.isArray(rd_) && Array.isArray(ld) && rd_.length === ld.length, label + ' · 行数', `real=${rd_ && rd_.length} local=${ld && ld.length}`);
  const n = Math.min(rd_ ? rd_.length : 0, ld ? ld.length : 0);
  let dimOk = true, valOk = true, cmpOk = true, firstBad = '';
  for (let i = 0; i < n; i++) {
    if (!close(rd_[i].dims, ld[i].dims)) { dimOk = false; if (!firstBad) firstBad = `行${i} dims real=${JSON.stringify(rd_[i].dims)} local=${JSON.stringify(ld[i].dims)}`; }
    for (const code of Object.keys(rd_[i].metrics)) {
      const a = rd_[i].metrics[code], b = ld[i].metrics[code];
      if (!close(a.value, b.value)) { valOk = false; if (!firstBad) firstBad = `行${i} ${code}.value real=${a.value} local=${b.value}`; }
      for (const kind of ['yoy', 'mom']) {
        const x = a[kind], y = b[kind];
        if ((x == null) !== (y == null)) { cmpOk = false; if (!firstBad) firstBad = `行${i} ${code}.${kind} 存在性 real=${!!x} local=${!!y}`; }
        else if (x && y && !(close(x.base, y.base) && close(x.delta, y.delta) && close(x.rate, y.rate) && x.policy === y.policy)) {
          cmpOk = false; if (!firstBad) firstBad = `行${i} ${code}.${kind} real=${JSON.stringify(x)} local=${JSON.stringify(y)}`;
        }
      }
    }
  }
  ok(dimOk, label + ' · 维度分组一致', firstBad);
  ok(valOk, label + ' · 指标值一致(±0.05)', firstBad);
  ok(cmpOk, label + ' · 同环比对象一致', firstBad);
  ok(close(real.body.meta.appliedFilters, local.body.meta.appliedFilters), label + ' · meta.appliedFilters',
    `real=${JSON.stringify(real.body.meta.appliedFilters)} local=${JSON.stringify(local.body.meta.appliedFilters)}`);
  ok(real.body.meta.sql === local.body.meta.sql, label + ' · meta.sql',
    `real=${real.body.meta.sql}\n         local=${local.body.meta.sql}`);
  ok(real.body.meta.rows === local.body.meta.rows && real.body.meta.truncated === local.body.meta.truncated,
    label + ' · meta.rows/truncated', `real=${real.body.meta.rows}/${real.body.meta.truncated} local=${local.body.meta.rows}/${local.body.meta.truncated}`);
  ok(close(real.body.meta.rlsApplied, local.body.meta.rlsApplied), label + ' · meta.rlsApplied',
    `real=${JSON.stringify(real.body.meta.rlsApplied)} local=${JSON.stringify(local.body.meta.rlsApplied)}`);
}

/* ============ 主流程 ============ */
(async () => {
  console.log('=== T18 demo shim 黄金对账 ===');
  console.log('QE init:', JSON.stringify(initInfo));
  const { server, port } = await startServer({ port: 0, quiet: true });
  const base = 'http://127.0.0.1:' + port;
  console.log('真实服务已启动：' + base + '\n');

  /* ① 全国按省 GDP（含 yoy） */
  {
    const dsl = {
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'province' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['yoy'] },
      limit: 50,
    };
    console.log('[① 全国按省 GDP 含 yoy] role=leader');
    const real = await httpQuery(base, dsl, 'leader');
    const local = localQuery(dsl, 'leader');
    assertSame('①', dsl, 'leader', real, local);
    global.__golden1_leader = real.body;   // ⑤ 复用为“江苏口径”基准
  }

  /* ② 江苏省按市（descendantOf） */
  {
    const dsl = {
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'city' }],
      filters: [{ dim: 'region', op: 'descendantOf', value: '320000' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
      sort: [{ by: 'MACRO.GDP.VA0001', order: 'desc' }],
      limit: 50,
    };
    console.log('[② 江苏省按市 descendantOf] role=leader');
    const real = await httpQuery(base, dsl, 'leader');
    const local = localQuery(dsl, 'leader');
    assertSame('②', dsl, 'leader', real, local);
  }

  /* ③ 制造业（industry_c1=in C）构成 → industry_c2 粒度 */
  {
    const dsl = {
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'industry', granularity: 'industry_c2' }],
      filters: [{ dim: 'industry', op: 'in', values: ['C'] }],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
      sort: [{ by: 'MACRO.GDP.VA0001', order: 'desc' }],
      limit: 50,
    };
    console.log('[③ 制造业构成 industry_c2] role=leader');
    const real = await httpQuery(base, dsl, 'leader');
    const local = localQuery(dsl, 'leader');
    assertSame('③', dsl, 'leader', real, local);
  }

  /* ④ 累计指标请求 mom → 403 COMPARE_POLICY_FORBIDDEN */
  {
    const dsl = {
      metrics: ['MACRO.INV.CU0004'],
      dimensions: [],
      time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['mom'] },
      limit: 50,
    };
    console.log('[④ 累计指标 mom → 403] role=leader');
    const real = await httpQuery(base, dsl, 'leader');
    const local = localQuery(dsl, 'leader');
    ok(real.status === 403 && local.status === 403, '④ · 双侧 403', `real=${real.status} local=${local.status}`);
    ok(!!(real.body.error && local.body.error && real.body.error.code === 'COMPARE_POLICY_FORBIDDEN' && local.body.error.code === 'COMPARE_POLICY_FORBIDDEN'),
      '④ · error.code=COMPARE_POLICY_FORBIDDEN',
      `real=${real.body.error && real.body.error.code} local=${local.body.error && local.body.error.code}`);
    assertSame('④', dsl, 'leader', real, local);   // error 分支：status/code 对齐
  }

  /* ⑤ prov-js 查全国 → rlsApplied 且值=江苏口径 */
  {
    const dsl = {
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'province' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['yoy'] },
      limit: 50,
    };
    console.log('[⑤ prov-js 查全国 → RLS 江苏口径] role=prov-js');
    const real = await httpQuery(base, dsl, 'prov-js');
    const local = localQuery(dsl, 'prov-js');
    assertSame('⑤', dsl, 'prov-js', real, local);
    ok(!!(local.body.meta && local.body.meta.rlsApplied), '⑤ · 本地 rlsApplied 非空',
      JSON.stringify(local.body.meta && local.body.meta.rlsApplied));
    const findRow = (res, code) => (res.data || []).find((r) => r.dims.region && r.dims.region.code === code);
    const lr = findRow(local.body, '320000'), rr = findRow(real.body, '320000');
    ok(!!lr && !!rr && close(lr, rr), '⑤ · 江苏(320000)行 shim=real', JSON.stringify(lr));
    ok(local.body.meta.rows === 1 && lr, '⑤ · prov-js 仅见 1 行（江苏）', `rows=${local.body.meta.rows}`);
    const leaderRow = findRow(global.__golden1_leader, '320000');
    ok(!!leaderRow && close(lr, leaderRow), '⑤ · shim 值=江苏口径（leader 基准行一致）',
      `local=${JSON.stringify(lr && lr.metrics)} leader=${JSON.stringify(leaderRow && leaderRow.metrics)}`);
  }

  /* ⑥ 时间范围过滤（filters.time_range 子区间） */
  {
    const dsl = {
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'time', granularity: 'time_month' }],
      filters: [{ dim: 'time', op: 'time_range', range: ['2026-06', '2026-08'] }],
      time: { grain: 'month', range: ['2026-01', '2026-10'] },
      limit: 50,
    };
    console.log('[⑥ filters.time_range 子区间] role=leader');
    const real = await httpQuery(base, dsl, 'leader');
    const local = localQuery(dsl, 'leader');
    assertSame('⑥', dsl, 'leader', real, local);
    const months = (local.body.data || []).map((r) => r.dims.time.code).sort();
    ok(JSON.stringify(months) === JSON.stringify(['2026-06', '2026-07', '2026-08']),
      '⑥ · 仅返回子区间 3 个月', JSON.stringify(months));
  }

  await new Promise((r) => server.close(() => r()));
  await new Promise((r) => setTimeout(r, 50));   // win32 libuv 句柄收尾缓冲，避免 process.exit 竞态断言
  console.log('\n=== 结果 ===');
  console.log(`PASS ${passed} / FAIL ${failed}（黄金查询 6 组）`);
  if (failed) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('6/6 GOLDEN PASS');
  process.exit(0);
})().catch((e) => { console.error('[FATAL]', e); process.exit(2); });

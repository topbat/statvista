'use strict';
/**
 * ============================================================================
 * T05 · 语义层服务自测脚本（独立可跑，零依赖）
 * 用法：node D:\local\visual\mvp\server\smoke.js
 *
 * 方式：随机端口启动 index.js 服务 → fetch 断言 → 输出 n/n 通过，全过退出码 0
 * 断言覆盖（任务书 6 项必做 + 契约 DoD 关键补充项）：
 *   ① 按省聚合 GDP 与手工计算一致（叶子行上卷 + yoy 基期）
 *   ② ratio 指标同比 = 先比分子分母再算比值（GR0001 契约算法 vs 响应，D3）
 *   ③ cumulative 指标请求 mom → 403 COMPARE_POLICY_FORBIDDEN（D4）
 *   ④ prov-js 查全国口径指标被裁剪为本省（meta.rlsApplied，D8）
 *   ⑤ watermark bump 后缓存失效（cacheHit false→true→false，D10/D11）
 *   ⑥ 未注册指标 → 404 METRIC_NOT_FOUND（D2）
 *   ⑦ 同维度值过滤 last-wins 消解（superseded/active，D15）
 *   ⑧ 行级越权 → 200 空集（D7）
 *   ⑨ 伪造授权参数剥离（与不带该字段响应一致，D9）
 *   ⑩ 静态服务 MIME 正确（echarts.min.js）+ SQL 无 JOIN（D1）+ 缺 X-Role → 401
 *   ⑪⑫ T25 alerts 实时预警（A1/RLS）+ T26 compile Doris 方言（双窗口）+ query meta.execution（v0.2）
 * ============================================================================
 */

const { startServer } = require('./index.js');

// ---- 手工期望值：独立读取种子事实，按契约公式重算（不经过服务代码路径）----
// 安全：静态字面量路径（不拼接运行时变量），避免动态路径进入模块加载器
const facts = require('../data/facts.json').rows;

/** Σ field（prov 限定 + 月份窗口 [s,e] 闭区间；行业行=口径行） */
function manualSum(field, prov, s, e) {
  let t = 0;
  for (const r of facts) {
    if (r.prov === prov && r.c1 != null && r.month >= s && r.month <= e && r.vals[field] != null) t += r.vals[field];
  }
  return t;
}

const EPS = 0.02; // 两位小数舍入容差
const near = (a, b) => Math.abs(a - b) < EPS;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + name + '  [' + detail + ']'); }
}

async function main() {
  const { server, port, state } = await startServer({ port: 0, quiet: true });
  const base = 'http://127.0.0.1:' + port;
  console.log(`[smoke] 服务已启动（随机端口 ${port}），开始断言...\n`);

  /** POST /query 快捷封装 */
  async function q(body, role) {
    const r = await fetch(base + '/api/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Role': role || 'leader' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  }

  /* ========== ① 按省聚合 GDP 与手工计算一致 ========== */
  {
    const r = await q({
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'province' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['yoy'] },
    });
    const exp = manualSum('gdp_va', '320000', '2026-10', '2026-10');          // 当期=Σ 叶子行
    const expBase = manualSum('gdp_va', '320000', '2025-10', '2025-10');       // yoy 基期=去年同期
    const js = r.json.data.find((d) => d.dims.region.code === '320000');
    const m = js.metrics['MACRO.GDP.VA0001'];
    check('①a 省级GDP当期值=手工上卷', r.status === 200 && near(m.value, exp), `value=${m.value} exp=${exp.toFixed(2)}`);
    check('①b yoy base/delta/rate=手工', near(m.yoy.base, expBase) && near(m.yoy.delta, m.value - expBase) && near(m.yoy.rate, (m.value - expBase) / Math.abs(expBase)),
      `base=${m.yoy.base} exp=${expBase.toFixed(2)} policy=${m.yoy.policy}`);
    check('①c 五省齐全且含维表名/path', r.json.meta.rows === 5 && js.dims.region.name === '江苏省' && js.dims.region.path === '/320000/');
  }

  /* ========== ② ratio 同比 = 先比分子分母再算比值（D3）========== */
  {
    const r = await q({
      metrics: ['MACRO.GDP.GR0001'],
      dimensions: [{ dim: 'region', granularity: 'province' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['yoy'] },
    });
    const js = r.json.data.find((d) => d.dims.region.code === '320000');
    const m = js.metrics['MACRO.GDP.GR0001'];
    // 契约算法（compare_then_compute）：分子分母各取当期/同期 ytd 窗口和再算比值
    const numT = manualSum('gdp_va', '320000', '2026-01', '2026-10');
    const denT = manualSum('gdp_va_py', '320000', '2026-01', '2026-10');
    const numB = manualSum('gdp_va', '320000', '2025-01', '2025-10');
    const denB = manualSum('gdp_va_py', '320000', '2025-01', '2025-10');
    const expValue = (numT / denT - 1) * 100;
    const expBase = (numB / denB - 1) * 100;   // 基期=去年同期窗口重算的比值（非直接相减）
    const wrongBase = (numB / denT - 1) * 100; // 错误算法示例（分母用当期）
    check('②a GR0001 value=先比分子分母', near(m.value, expValue), `value=${m.value} exp=${expValue.toFixed(2)}`);
    check('②b yoy.base=同期窗口重算比值', m.yoy.policy === 'compare_then_compute' && near(m.yoy.base, expBase) && !near(m.yoy.base, wrongBase),
      `base=${m.yoy.base} exp=${expBase.toFixed(2)} wrong=${wrongBase.toFixed(2)}`);
    check('②c delta=两比值之差且 rate=null', near(m.yoy.delta, expValue - expBase) && m.yoy.rate === null, `delta=${m.yoy.delta}`);
    check('②d 黄金数值：江苏累计增速 3.88', near(m.value, 3.88), `value=${m.value}（facts.meta.stats 预埋值 3.88）`);
  }

  /* ========== ③ cumulative 请求 mom → 403 ========== */
  {
    const r = await q({
      metrics: ['MACRO.INV.CU0004'],
      time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['mom'] },
    });
    check('③ cumulative×mom → 403 COMPARE_POLICY_FORBIDDEN',
      r.status === 403 && r.json.error.code === 'COMPARE_POLICY_FORBIDDEN' &&
      r.json.error.detail.policy === 'cumulative' && r.json.error.detail.requested === 'mom' && !r.json.data,
      `status=${r.status} code=${r.json.error && r.json.error.code}`);
    // 对照：snapshot×mom 同样拒绝；cumulative×yoy 放行
    const r2 = await q({ metrics: ['TECH.RDP.SN0006'], time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['mom'] } });
    const r3 = await q({ metrics: ['MACRO.INV.CU0004'], time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['yoy'] } });
    check('③b snapshot×mom 拒 / cumulative×yoy 放', r2.status === 403 && r3.status === 200 && r3.json.data[0].metrics['MACRO.INV.CU0004'].yoy.policy === 'cumulative',
      `sn=${r2.status} invYoy=${r3.status}`);
  }

  /* ========== ④ prov-js 查全国指标被裁剪为本省（D8）========== */
  {
    const r = await q({
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'province' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
    }, 'prov-js');
    const exp = manualSum('gdp_va', '320000', '2026-10', '2026-10');
    check('④ 只见江苏一行且值=本省口径',
      r.status === 200 && r.json.data.length === 1 && r.json.data[0].dims.region.code === '320000' &&
      near(r.json.data[0].metrics['MACRO.GDP.VA0001'].value, exp),
      `rows=${r.json.meta.rows} value=${r.json.data[0] && r.json.data[0].metrics['MACRO.GDP.VA0001'].value}`);
    const ra = r.json.meta.rlsApplied;
    check('④b meta.rlsApplied 指明裁剪范围', !!ra && ra.dim === 'region' && ra.scopePath === '/320000/' && ra.visibleRoot === '320000' && r.json.meta.rlsRole === 'prov-js',
      JSON.stringify(ra));
  }

  /* ========== ⑤ watermark bump → 缓存失效 ========== */
  {
    const cq = { metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-09', '2026-10'] } };
    const wm0 = state.watermark;
    const a = await q(cq); const b = await q(cq);
    const keyLeader = a.json.meta.cacheKey;
    // 不同角色同 DSL → 不同缓存键（D10 角色分键）
    const pj = await q(cq, 'prov-js');
    await fetch(base + '/api/v1/admin/watermark', { method: 'POST', body: '{}' });
    const c = await q(cq);
    check('⑤ 缓存 miss→hit→bump后 miss',
      a.json.meta.cacheHit === false && b.json.meta.cacheHit === true && c.json.meta.cacheHit === false && state.watermark !== wm0,
      `${a.json.meta.cacheHit}→${b.json.meta.cacheHit}→${c.json.meta.cacheHit} wm:${wm0}→${state.watermark}`);
    check('⑤b leader 与 prov-js 缓存键不同（角色分键）', keyLeader !== pj.json.meta.cacheKey, `${keyLeader} vs ${pj.json.meta.cacheKey}`);
  }

  /* ========== ⑥ 未注册指标 → 404 ========== */
  {
    const r = await q({ metrics: ['MACRO.GDP.XX9999'], time: { grain: 'month', range: ['2026-10', '2026-10'] } });
    check('⑥ 未注册编码 → 404 METRIC_NOT_FOUND',
      r.status === 404 && r.json.error.code === 'METRIC_NOT_FOUND' && r.json.error.detail.metric === 'MACRO.GDP.XX9999' && !r.json.data,
      `status=${r.status}`);
    const r2 = await q({ metrics: ['GDP; DROP TABLE facts'], time: { grain: 'month', range: ['2026-10', '2026-10'] } });
    check('⑥b 裸 SQL 片段 → 400 DSL_SCHEMA_INVALID', r2.status === 400 && r2.error === undefined && r2.json.error.code === 'DSL_SCHEMA_INVALID', `status=${r2.status}`);
  }

  /* ========== ⑦ 同维度 last-wins 消解（D15）========== */
  {
    const r = await q({
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'industry', granularity: 'industry_c2' }],
      filters: [
        { dim: 'region', op: 'descendantOf', value: '320000' },
        { dim: 'industry', op: 'in', values: ['I'], sourceChartId: 'c3-industry-mix' },
        { dim: 'industry', op: 'in', values: ['C'], sourceChartId: 'c3-industry-mix' },
      ],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
    });
    const af = r.json.meta.appliedFilters;
    const sup = af.find((f) => f.values && f.values[0] === 'I');
    const act = af.find((f) => f.values && f.values[0] === 'C');
    check('⑦ last-wins：I=superseded C=active 且结果仅制造业',
      sup && sup.status === 'superseded' && act && act.status === 'active' &&
      r.json.data.length === 4 && r.json.data.every((d) => d.dims.industry.path.startsWith('/C/')) &&
      !r.json.meta.sql.includes("'I'"),
      `rows=${r.json.meta.rows} 全C=${r.json.data.every((d) => d.dims.industry.path.startsWith('/C/'))}`);
  }

  /* ========== ⑧ 行级越权 → 200 空集（D7）========== */
  {
    const r = await q({
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'city' }],
      filters: [{ dim: 'region', op: 'descendantOf', value: '440000' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
    }, 'prov-js');
    check('⑧ prov-js 下钻广东 → 200 空集不报错',
      r.status === 200 && Array.isArray(r.json.data) && r.json.data.length === 0 && r.json.meta.rows === 0,
      `status=${r.status} rows=${r.json.meta && r.json.meta.rows}`);
  }

  /* ========== ⑨ 伪造授权参数剥离（D9）========== */
  {
    const plain = { metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] } };
    const forged = Object.assign({ rls: 'role:leader', forceRegion: '/440000/', role: 'leader' }, JSON.parse(JSON.stringify(plain)));
    const a = await q(forged, 'prov-js');
    const b = await q(plain, 'prov-js');
    check('⑨ 剥离后与不带伪造字段逐字节一致',
      a.status === 200 && JSON.stringify(a.json.data) === JSON.stringify(b.json.data) &&
      a.json.meta.sql === b.json.meta.sql && a.json.meta.cacheKey === b.json.meta.cacheKey,
      `value=${a.json.data[0].metrics['MACRO.GDP.VA0001'].value} key同=${a.json.meta.cacheKey === b.json.meta.cacheKey}`);
  }

  /* ========== ⑩ 静态 MIME / SQL 无 JOIN / 401 ========== */
  {
    const st = await fetch(base + '/assets/echarts.min.js');
    check('⑩a echarts.min.js 200 + text/javascript; charset=utf-8',
      st.status === 200 && /text\/javascript; charset=utf-8/.test(st.headers.get('content-type') || ''),
      st.headers.get('content-type'));
    const r = await q({ metrics: ['MACRO.GDP.VA0001'], dimensions: [{ dim: 'region', granularity: 'city' }], time: { grain: 'month', range: ['2026-10', '2026-10'] } });
    check('⑩b meta.sql 无 JOIN（D1）', !/\bJOIN\b/i.test(r.json.meta.sql), r.json.meta.sql);
    const no = await fetch(base + '/api/v1/query', { method: 'POST', body: JSON.stringify({ metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] } }) });
    const noJson = await no.json();
    check('⑩c 缺 X-Role → 401 UNAUTHENTICATED', no.status === 401 && noJson.error.code === 'UNAUTHENTICATED', `status=${no.status}`);
  }

  /* ========== ⑪ T25 alerts 实时预警 + ⑫ T26 compile Doris 方言（v0.2 新端点冒烟） ========== */
  {
    const al = await fetch(base + '/api/v1/alerts', { headers: { 'X-Role': 'leader' } });
    const alJ = await al.json();
    const a1 = (alJ.items || []).find((i) => i.regionCode === '320000' && i.metricCode === 'MACRO.IND.VA0002');
    check('⑪ T25 alerts：leader 视角含江苏规上工业 danger 且 months≥5（A1 服务端实时算出）',
      al.status === 200 && alJ.asof === '2026-10' && !!a1 && a1.level === 'danger' && a1.months >= 5,
      `asof=${alJ.asof} items=${(alJ.items || []).length}`);
    const pj = await fetch(base + '/api/v1/alerts', { headers: { 'X-Role': 'prov-js' } });
    const pjJ = await pj.json();
    check('⑪b T25 alerts RLS：prov-js 仅见江苏', pj.status === 200 && pjJ.items.every((i) => i.regionCode === '320000'),
      `items=${pjJ.items.length}`);
    const cp = await fetch(base + '/api/v1/compile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Role': 'leader' }, body: JSON.stringify({ metrics: ['MACRO.GDP.GR0001'], dimensions: [{ dim: 'region', granularity: 'province' }], time: { grain: 'month', range: ['2026-01', '2026-09'], compare: ['yoy'] } }) });
    const cpJ = await cp.json();
    check('⑫ T26 compile：GR0001 同比编译出 dwd_stat_fact 双窗口 SQL（对比期 period 2025-01..2025-09）',
      cp.status === 200 && cpJ.dialect === 'doris' && /dwd_stat_fact/.test(cpJ.sql) && /period >= '2025-01' AND period <= '2025-09'/.test(cpJ.sql),
      `executor=${cpJ.executor} warnings=${(cpJ.warnings || []).length}`);
    const qe = await fetch(base + '/api/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Role': 'leader' }, body: JSON.stringify({ metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] } }) });
    const qeJ = await qe.json();
    check('⑫b query meta.execution：{backend=local, sqlHash, durMs}', qe.status === 200 && qeJ.meta.execution &&
      qeJ.meta.execution.backend === 'local' && /^sha256:[0-9a-f]{64}$/.test(qeJ.meta.execution.sqlHash) && typeof qeJ.meta.execution.durMs === 'number',
      `durMs=${qeJ.meta.execution && qeJ.meta.execution.durMs}`);
  }

  /* ---- 汇总 ---- */
  console.log(`\n[smoke] 结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
  server.close();
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 300);
}

main().catch((e) => { console.error('[smoke] 运行异常：', e); process.exit(1); });

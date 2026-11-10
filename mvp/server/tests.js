'use strict';
/**
 * ============================================================================
 * T08 · MVP 原型 DoD 逐项功能测试套件（零依赖，独立可跑）
 * 用法：node D:\local\visual\mvp\server\tests.js
 *
 * 依据：docs/mvp/01-PRD.md §3 DoD D1–D17（权威）+ docs/mvp/03-DSL与API契约.md
 * 方式：随机端口启动被测服务（复用 index.js startServer）→ fetch 断言 → 逐条打印
 *       [PASS]/[FAIL] DoD编号-说明 → 末尾汇总 X/Y → 退出码 0/1
 * 纪律：只测不修。手工期望值独立读取 mvp/data/facts.json 按契约公式重算，
 *       不复用服务端聚合代码路径（smoke 经验）。
 * 覆盖：12 组可自动断言 DoD（D1/D2/D3/D4/D6/D7/D8/D9/D10/D11/D14+D15/D16/D17 的
 *       API/静态子项）+ 静态资源 + 错误码边界。D5/D12/D13 的 UI 子项与 D14/D15 的
 *       视觉子项为人工双验证，见 docs/mvp/05-测试报告.md。
 * ============================================================================
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { startServer, shiftMonth, metricWindow } = require('./index.js');
const dorisMod = require('./doris.js'); // T26：编译器/Executor 单元断言用（黄金快照仍走 HTTP 端到端）

/* ==================== 手工期望值计算（独立于服务代码路径） ==================== */
// 安全：静态字面量路径（不拼接运行时变量），避免动态路径进入模块加载器
const facts = require('../data/facts.json').rows;
const dimsDoc = require('../data/dims.json');

/** Σ field：pred 行筛选 + 月份窗口 [s,e] 闭区间；窗口内无行 → null */
function manualSum(field, pred, s, e) {
  let t = 0, n = 0;
  for (const r of facts) {
    if (pred(r) && r.month >= s && r.month <= e && r.vals[field] != null) { t += r.vals[field]; n++; }
  }
  return n > 0 ? t : null;
}
const indOf = (prov) => (r) => r.prov === prov && r.c2 != null; // 行业行（fact_ind 行族）
const r2 = (x) => Math.round(x * 100) / 100;

const EPS = 0.02; // 服务端两位小数舍入容差
const near = (a, b) => a != null && b != null && Math.abs(a - b) < EPS;

/* ---- 预计算的黄金期望（脚本启动时独立核算一遍，供断言引用） ---- */
const EXP = (() => {
  // 例1（sum 型）：广东 GDP 当月值 2026-10 + yoy
  const gVal = manualSum('gdp_va', indOf('440000'), '2026-10', '2026-10');
  const gBase = manualSum('gdp_va', indOf('440000'), '2025-10', '2025-10');
  // 例2（ratio 型）：江苏 发明专利授权占比 2026-10 + yoy（compare_then_compute）
  const pN = manualSum('pat_inv', indOf('320000'), '2026-10', '2026-10');
  const pD = manualSum('pat_va', indOf('320000'), '2026-10', '2026-10');
  const pNb = manualSum('pat_inv', indOf('320000'), '2025-10', '2025-10');
  const pDb = manualSum('pat_va', indOf('320000'), '2025-10', '2025-10');
  // D3：江苏 GDP 累计同比增速 2026-10（ytd 窗口，正确 vs 错误算法）
  const nT = manualSum('gdp_va', indOf('320000'), '2026-01', '2026-10');
  const dT = manualSum('gdp_va_py', indOf('320000'), '2026-01', '2026-10');
  const nB = manualSum('gdp_va', indOf('320000'), '2025-01', '2025-10');
  const dB = manualSum('gdp_va_py', indOf('320000'), '2025-01', '2025-10');
  // D6：南京 GR0001 yoy 基期（市级下钻正交）
  const nJ = manualSum('gdp_va', (r) => r.city === '320100', '2026-01', '2026-10');
  const dJ = manualSum('gdp_va_py', (r) => r.city === '320100', '2026-01', '2026-10');
  const nJb = manualSum('gdp_va', (r) => r.city === '320100', '2025-01', '2025-10');
  const dJb = manualSum('gdp_va_py', (r) => r.city === '320100', '2025-01', '2025-10');
  // D8：江苏本省口径 GDP（prov-js 视角）
  const jsVal = manualSum('gdp_va', indOf('320000'), '2026-10', '2026-10');
  return {
    gVal, gBase, gDelta: gVal - gBase, gRate: (gVal - gBase) / Math.abs(gBase),
    pVal: (pN / pD) * 100, pBase: (pNb / pDb) * 100,
    grVal: (nT / dT - 1) * 100, grBase: (nB / dB - 1) * 100,
    grWrongBase: (nB / dT - 1) * 100, // 错误算法：分母误用当期窗口
    njVal: (nJ / dJ - 1) * 100, njBase: (nJb / dJb - 1) * 100,
    jsVal,
  };
})();

/* ==================== 断言输出 ==================== */

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('[FAIL] ' + name + '  [' + detail + ']'); }
}

/* ==================== 主流程 ==================== */

async function main() {
  const { server, port, state } = await startServer({ port: 0, quiet: true });
  const base = 'http://127.0.0.1:' + port;
  console.log('[tests] 被测服务已启动（随机端口 ' + port + '）');
  console.log('[tests] 手工黄金期望：广东GDP=' + r2(EXP.gVal) + ' 江苏发明占比=' + r2(EXP.pVal) + ' 江苏GR0001=' + r2(EXP.grVal) + '\n');

  async function q(body, role) {
    const r = await fetch(base + '/api/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Role': role || 'leader' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  }
  async function get(p, role) {
    const r = await fetch(base + p, { headers: role ? { 'X-Role': role } : {} });
    return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
  }

  /* ========== D1 聚合正确性 · 例1 sum 型（广东 GDP 当月值 + yoy） ========== */
  {
    const r = await q({
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'province' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['yoy'] },
    });
    const gd = r.json.data.find((d) => d.dims.region.code === '440000');
    const m = gd && gd.metrics['MACRO.GDP.VA0001'];
    check('D1-例1 sum型聚合=手工上卷(广东GDP 2026-10)',
      r.status === 200 && near(m.value, EXP.gVal),
      `value=${m && m.value} 期望=${r2(EXP.gVal)}（facts.json 手工Σ）`);
    check('D1-例1 yoy base/delta/rate=手工直比',
      near(m.yoy.base, EXP.gBase) && near(m.yoy.delta, EXP.gDelta) && Math.abs(m.yoy.rate - EXP.gRate) < 0.0002 && m.yoy.policy === 'direct',
      `base=${m.yoy.base} delta=${m.yoy.delta} rate=${m.yoy.rate}`);
    check('D1-编译产物SQL无JOIN(下钻=换group by列+等值过滤)',
      !/\bJOIN\b/i.test(r.json.meta.sql) && /GROUP BY region_prov/.test(r.json.meta.sql),
      r.json.meta.sql);
    check('D1-SQL物理列名符合契约§2.2.2(region_prov/ind_c1)',
      /GROUP BY region_prov/.test(r.json.meta.sql),
      r.json.meta.sql);
  }

  /* ========== D1 聚合正确性 · 例2 ratio 型（江苏发明占比 + yoy 先比子项） ========== */
  {
    const r = await q({
      metrics: ['TECH.PAT.SH0004'],
      dimensions: [{ dim: 'region', granularity: 'province' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['yoy'] },
    });
    const js = r.json.data.find((d) => d.dims.region.code === '320000');
    const m = js && js.metrics['TECH.PAT.SH0004'];
    check('D1-例2 ratio型value=Σ分子/Σ分母手工值',
      near(m.value, EXP.pVal), `value=${m && m.value} 期望=${r2(EXP.pVal)}`);
    check('D1-例2 yoy.base=基期窗口重算比值(非直接相减)',
      m.yoy.policy === 'compare_then_compute' && near(m.yoy.base, EXP.pBase) && near(m.yoy.delta, EXP.pVal - EXP.pBase) && m.yoy.rate === null,
      `base=${m.yoy.base} delta=${m.yoy.delta} rate=${m.yoy.rate}`);
  }

  /* ========== D2 未注册编码 / 裸 SQL → 4xx + 错误结构 ========== */
  {
    const r = await q({ metrics: ['MACRO.GDP.XX9999'], time: { grain: 'month', range: ['2026-10', '2026-10'] } });
    const e = r.json.error || {};
    check('D2-未注册编码→404 METRIC_NOT_FOUND含文案与detail',
      r.status === 404 && e.code === 'METRIC_NOT_FOUND' && /未注册/.test(e.message) &&
      e.detail && e.detail.metric === 'MACRO.GDP.XX9999' && typeof e.traceId === 'string' && r.json.data === undefined,
      `status=${r.status} detail=${JSON.stringify(e.detail)}`);
    const r2b = await q({ metrics: ['GDP; DROP TABLE facts'], time: { grain: 'month', range: ['2026-10', '2026-10'] } });
    check('D2-裸SQL片段→400 DSL_SCHEMA_INVALID不产生查询',
      r2b.status === 400 && r2b.json.error.code === 'DSL_SCHEMA_INVALID' && r2b.json.data === undefined,
      `status=${r2b.status}`);
  }

  /* ========== D3 ratio 先比子项（构造数据使两法差≥0.1pct） ========== */
  {
    const r = await q({
      metrics: ['MACRO.GDP.GR0001'],
      dimensions: [{ dim: 'region', granularity: 'province' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['yoy'] },
    });
    const js = r.json.data.find((d) => d.dims.region.code === '320000');
    const m = js && js.metrics['MACRO.GDP.GR0001'];
    const rightDelta = EXP.grVal - EXP.grBase;          // 契约算法
    const wrongDelta = EXP.grVal - EXP.grWrongBase;     // 禁止算法（分母误用当期）
    check('D3-先比分子分母再算比值(两法差≥0.1pct时取前者)',
      near(m.value, EXP.grVal) && near(m.yoy.base, EXP.grBase) && near(m.yoy.delta, rightDelta) &&
      Math.abs(rightDelta - wrongDelta) >= 0.1 && !near(m.yoy.base, EXP.grWrongBase),
      `delta=${m.yoy.delta} 正确=${r2(rightDelta)} 错误法=${r2(wrongDelta)} 差=${r2(Math.abs(rightDelta - wrongDelta))}pct`);
  }

  /* ========== D4 累计/快照禁环比、仅同比 ========== */
  {
    const r = await q({ metrics: ['MACRO.INV.CU0004'], time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['mom'] } });
    const e = r.json.error || {};
    check('D4-cumulative×mom→403 COMPARE_POLICY_FORBIDDEN',
      r.status === 403 && e.code === 'COMPARE_POLICY_FORBIDDEN' && /累计型指标禁用环比/.test(e.message) &&
      e.detail.policy === 'cumulative' && e.detail.requested === 'mom',
      `status=${r.status} detail=${JSON.stringify(e.detail)}`);
    const sn = await q({ metrics: ['TECH.RDP.SN0006'], time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['mom'] } });
    const yoy = await q({ metrics: ['MACRO.INV.CU0004'], time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['yoy'] } });
    check('D4-snapshot×mom同拒/cumulative×yoy放行且回显策略',
      sn.status === 403 && yoy.status === 200 && yoy.json.data[0].metrics['MACRO.INV.CU0004'].yoy.policy === 'cumulative',
      `sn=${sn.status} invYoy=${yoy.status}`);
  }

  /* ========== D6 下钻与同环比正交（市级 yoy 与省级同口径） ========== */
  {
    const r = await q({
      metrics: ['MACRO.GDP.GR0001'],
      dimensions: [{ dim: 'region', granularity: 'city' }],
      filters: [{ dim: 'region', op: 'descendantOf', value: '320000' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['yoy'] },
    });
    const nj = r.json.data.find((d) => d.dims.region.code === '320100');
    const m = nj && nj.metrics['MACRO.GDP.GR0001'];
    check('D6-市级ratio同比=该市窗口手工重算(时间子句正交传递)',
      r.status === 200 && near(m.value, EXP.njVal) && near(m.yoy.base, EXP.njBase) && m.yoy.policy === 'compare_then_compute',
      `南京 value=${m && m.value}/${r2(EXP.njVal)} base=${m.yoy.base}/${r2(EXP.njBase)} 行数=${r.json.meta.rows}`);
    const allHaveYoy = r.json.data.every((d) => d.metrics['MACRO.GDP.GR0001'].yoy !== undefined);
    check('D6-一次查询多子查询返回当期+同期(各行均含yoy)', allHaveYoy, `rows=${r.json.meta.rows}`);
  }

  /* ========== D7 行级越权 → 200 空集 ========== */
  {
    const r = await q({
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'city' }],
      filters: [{ dim: 'region', op: 'descendantOf', value: '440000' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
    }, 'prov-js');
    check('D7-prov-js下钻广东→200空集不报错不泄露',
      r.status === 200 && Array.isArray(r.json.data) && r.json.data.length === 0 && r.json.meta.rows === 0,
      `status=${r.status} rows=${r.json.meta && r.json.meta.rows}`);
    // 维度树端点同语义
    const t = await get('/api/v1/meta/dims?dim=region&parent=440000', 'prov-js');
    check('D7b-dims端点越权parent→200空集', t.status === 200 && t.json.data.length === 0, `count=${t.json.meta.count}`);
  }

  /* ========== D8 prov-js 全裁剪（指标卡/排名/维度树） ========== */
  {
    const r = await q({
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'province' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
    }, 'prov-js');
    const rows = r.json.data;
    check('D8-省级查询仅见江苏且值=本省口径',
      r.status === 200 && rows.length === 1 && rows[0].dims.region.code === '320000' && near(rows[0].metrics['MACRO.GDP.VA0001'].value, EXP.jsVal),
      `rows=${r.json.meta.rows} value=${rows[0] && rows[0].metrics['MACRO.GDP.VA0001'].value} 期望=${r2(EXP.jsVal)}`);
    const ra = r.json.meta.rlsApplied;
    check('D8b-meta.rlsApplied指明裁剪谓词与可见根',
      !!ra && ra.dim === 'region' && ra.scopePath === '/320000/' && ra.visibleRoot === '320000' && r.json.meta.rlsRole === 'prov-js',
      JSON.stringify(ra));
    const c = await q({
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'city' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
    }, 'prov-js');
    const allJS = c.json.data.every((d) => d.dims.region.path.startsWith('/320000/'));
    check('D8c-市级排名全部行region_path以/320000/开头',
      c.status === 200 && c.json.data.length === 4 && allJS,
      `rows=${c.json.meta.rows} 全江苏=${allJS}`);
    const root = await get('/api/v1/meta/dims?dim=region', 'prov-js');
    const rootOK = root.status === 200 && root.json.meta.parent === '320000' &&
      root.json.data.length > 0 && root.json.data.every((n) => n.path.startsWith('/320000/'));
    check('D8d-维度树根改写为本省子树', rootOK, `parent=${root.json.meta.parent} count=${root.json.meta.count}`);
  }

  /* ========== D9 伪造授权参数剥离（逐字节一致） ========== */
  {
    const plain = { metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-09', '2026-10'] } };
    const forged = Object.assign({ rls: 'role:leader', forceRegion: '/440000/', role: 'leader', region: '440000', where: '1=1' }, JSON.parse(JSON.stringify(plain)));
    const a = await q(forged, 'prov-js');
    const b = await q(plain, 'prov-js');
    const strip = (j) => JSON.stringify({ data: j.data, sql: j.meta.sql, cacheKey: j.meta.cacheKey, rls: j.meta.rlsApplied, rows: j.meta.rows });
    check('D9-伪造rls/role/region字段剥离后行为逐字节一致',
      a.status === 200 && strip(a.json) === strip(b.json) && a.json.meta.rlsRole === 'prov-js',
      `value=${a.json.data[0].metrics['MACRO.GDP.VA0001'].value} key同=${a.json.meta.cacheKey === b.json.meta.cacheKey}`);
  }

  /* ========== D10 缓存命中 + 角色分键 ========== */
  {
    const cq = { metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-08', '2026-10'] } };
    const a = await q(cq); const b = await q(cq);
    check('D10-同请求miss→hit', a.json.meta.cacheHit === false && b.json.meta.cacheHit === true,
      `${a.json.meta.cacheHit}→${b.json.meta.cacheHit} key=${a.json.meta.cacheKey}`);
    const pj = await q(cq, 'prov-js');
    const pg = await q(cq, 'prov-gd');
    check('D10b-leader/prov-js/prov-gd三角色缓存键互异',
      a.json.meta.cacheKey !== pj.json.meta.cacheKey && pj.json.meta.cacheKey !== pg.json.meta.cacheKey && a.json.meta.cacheKey !== pg.json.meta.cacheKey,
      `${a.json.meta.cacheKey} | ${pj.json.meta.cacheKey} | ${pg.json.meta.cacheKey}`);
  }

  /* ========== D11 三类 bump 事件全部失效 ========== */
  {
    const cq = { metrics: ['MACRO.GDP.VA0001'], dimensions: [{ dim: 'region', granularity: 'province' }], time: { grain: 'month', range: ['2026-07', '2026-10'] } };
    const seq = [];
    for (const factor of ['watermark', 'metricDef', 'dimTree']) {
      await q(cq); const hit = await q(cq);                       // 预热至命中
      const before = factor === 'watermark' ? state.watermark : factor === 'metricDef' ? state.metricDefVersion : state.dimTreeVersion;
      await fetch(base + '/api/v1/admin/watermark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ factor }) });
      const miss = await q(cq);                                   // bump 后同请求
      const after = factor === 'watermark' ? state.watermark : factor === 'metricDef' ? state.metricDefVersion : state.dimTreeVersion;
      seq.push(`${factor}:${hit.json.meta.cacheHit}→${miss.json.meta.cacheHit}(${before}→${after})`);
      if (!(hit.json.meta.cacheHit === true && miss.json.meta.cacheHit === false && before !== after)) break;
    }
    check('D11-watermark/metricDef/dimTree三bump均使缓存失效', seq.length === 3, seq.join(' '));
  }

  /* ========== D14/D15 联动过滤：last-wins / 异维度AND / sourceChartId不入键 ========== */
  {
    // ① 同维度 last-wins（I 被 C 覆盖）
    const r = await q({
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'industry', granularity: 'industry_c2' }],
      filters: [
        { dim: 'region', op: 'descendantOf', value: '320000' },
        { dim: 'industry', op: 'in', values: ['I'], sourceChartId: 'c1-industry-donut' },
        { dim: 'industry', op: 'in', values: ['C'], sourceChartId: 'c1-industry-donut' },
      ],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
    });
    const af = r.json.meta.appliedFilters;
    const supI = af.find((f) => f.values && f.values[0] === 'I');
    const actC = af.find((f) => f.values && f.values[0] === 'C');
    check('D15①-同维度last-wins(I=superseded C=active非并集)',
      supI && supI.status === 'superseded' && supI.sourceChartId === 'c1-industry-donut' &&
      actC && actC.status === 'active' && r.json.data.length > 0 &&
      r.json.data.every((d) => d.dims.industry.path.startsWith('/C/')) && !r.json.meta.sql.includes("'I'"),
      `rows=${r.json.meta.rows} 全C=${r.json.data.every((d) => d.dims.industry.path.startsWith('/C/'))}`);
    // ② 异维度 AND（region 320000 ∩ industry C）
    const expC = manualSum('gdp_va', (x) => x.prov === '320000' && x.c1 === 'C', '2026-10', '2026-10');
    const r2b = await q({
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'city' }],
      filters: [
        { dim: 'region', op: 'descendantOf', value: '320000' },
        { dim: 'industry', op: 'in', values: ['C'], sourceChartId: 'c1-industry-donut' },
      ],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
    });
    const total = r2b.json.data.reduce((t, d) => t + d.metrics['MACRO.GDP.VA0001'].value, 0);
    check('D15②-异维度事件AND交集(江苏∩制造业=手工Σ)',
      r2b.status === 200 && near(total, expC) && r2b.json.data.every((d) => d.dims.region.path.startsWith('/320000/')),
      `Σ=${r2(total)} 期望=${r2(expC)}`);
    // ③ sourceChartId 不参与缓存键（同语义带/不带 → 同键命中）
    const withSrc = await q({
      metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-06', '2026-10'] },
      filters: [{ dim: 'industry', op: 'in', values: ['C'], sourceChartId: 'c1-industry-donut' }],
    });
    const noSrc = await q({
      metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-06', '2026-10'] },
      filters: [{ dim: 'industry', op: 'in', values: ['C'] }],
    });
    check('D15③-sourceChartId剥离后同语义命中同缓存',
      withSrc.json.meta.cacheKey === noSrc.json.meta.cacheKey && noSrc.json.meta.cacheHit === true,
      `key=${withSrc.json.meta.cacheKey}/${noSrc.json.meta.cacheKey} hit=${noSrc.json.meta.cacheHit}`);
    // D14 数值断言：联动后结果仅含制造业大类
    check('D14-联动重取数结果仅含制造业大类(4个C大类)',
      r.json.meta.rows === 4 && r.json.data.map((d) => d.dims.industry.code).sort().join(',') === ['13', '26', '34', '39'].join(','),
      `大类=${r.json.data.map((d) => d.dims.industry.code).join(',')}`);
  }

  /* ========== 下钻 descendantOf 语义（D1/D12/D13 的 API 基座） ========== */
  {
    const r = await q({
      metrics: ['MACRO.GDP.VA0001'],
      dimensions: [{ dim: 'region', granularity: 'city' }],
      filters: [{ dim: 'region', op: 'descendantOf', value: '320000' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
    });
    check('DRILL-descendantOf编译为等值过滤且全行path前缀匹配',
      r.status === 200 && /region_prov = '320000'/.test(r.json.meta.sql) &&
      r.json.data.length === 4 && r.json.data.every((d) => d.dims.region.path.startsWith('/320000/')),
      `sql含等值=${/region_prov = '320000'/.test(r.json.meta.sql)} rows=${r.json.meta.rows}`);
    const ind = await q({
      metrics: ['MACRO.IND.VA0002'],
      dimensions: [{ dim: 'industry', granularity: 'industry_c2' }],
      filters: [{ dim: 'industry', op: 'descendantOf', value: 'C' }],
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
    });
    check('DRILLb-行业descendantOf C门类→仅C下大类',
      ind.status === 200 && ind.json.data.length === 4 && ind.json.data.every((d) => d.dims.industry.path.startsWith('/C/')),
      `rows=${ind.json.meta.rows}`);
  }

  /* ========== D16 元数据结构化字段 + 新增指标即时生效 ========== */
  {
    const r = await get('/api/v1/meta/metrics', 'leader');
    const list = r.json.data;
    const inv = list.find((m) => m.code === 'MACRO.INGI.GR0009') || list.find((m) => m.code === 'MACRO.ENGI.GR0009');
    const cu = list.find((m) => m.code === 'MACRO.INV.CU0004');
    check('D16①-字典返回16指标且aggType/comparePolicy/polarity/allowedCompares结构化',
      r.status === 200 && list.length === 16 && list.every((m) => m.aggType && m.comparePolicy && m.polarity && Array.isArray(m.allowedCompares) && m.unit && m.ownerDept),
      `count=${list.length}`);
    check('D16①b-逆指标polarity=inverse且累计型allowedCompares=[yoy]',
      inv && inv.polarity === 'inverse' && inv.comparePolicy === 'compare_then_compute' &&
      cu && cu.comparePolicy === 'cumulative' && JSON.stringify(cu.allowedCompares) === '["yoy"]',
      `能耗.polarity=${inv && inv.polarity} 投资.allowed=${cu && JSON.stringify(cu.allowedCompares)}`);
    const kw = await get('/api/v1/meta/metrics?q=' + encodeURIComponent('能耗'), 'leader');
    check('D16①c-按q=能耗检索命中逆指标', kw.status === 200 && kw.json.data.length === 1 && kw.json.data[0].code === 'MACRO.ENGI.GR0009',
      `filtered=${kw.json.meta.filtered}`);
  }
  { // D16②：临时数据目录新增测试指标（不动被测 data/ 原文件）→ 字典即时返回
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't08-data-'));
    fs.cpSync(path.join(__dirname, '..', 'data'), tmpDir, { recursive: true });
    const mp = path.join(tmpDir, 'metrics.json');
    const md = JSON.parse(fs.readFileSync(mp, 'utf8'));
    md.metrics.push({
      code: 'TECH.TEST.TS9999', name: 'T08临时测试指标（逆）', theme: 'tech', unit: '件', type: 'atomic',
      agg_type: 'sum', compare_policy: 'window_sum', compare_ops: ['yoy'], polarity: 'negative',
      formula: { kind: 'atomic', expr: 'SUM(fact.vals.pat_va)' },
      dim_caps: { region: ['country', 'prov', 'city'], industry: ['c1', 'c2'], time: ['month'] },
      store: { field: 'pat_va' }, owner: 'T08测试处', freq: '月度', data_level: '一般', basis: '测试占位', desc: 'D16② 临时新增',
    });
    fs.writeFileSync(mp, JSON.stringify(md));
    const app2 = await startServer({ port: 0, quiet: true, dataDir: tmpDir });
    try {
      const r = await fetch('http://127.0.0.1:' + app2.port + '/api/v1/meta/metrics?domain=tech', { headers: { 'X-Role': 'leader' } });
      const j = await r.json();
      const nt = j.data.find((m) => m.code === 'TECH.TEST.TS9999');
      check('D16②-临时新增指标(含inverse)不改前端即出现在字典',
        r.status === 200 && !!nt && nt.polarity === 'inverse' && j.meta.count === 17,
        `count=${j.meta.count} 新指标polarity=${nt && nt.polarity}`);
    } finally {
      app2.server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /* ========== D17 静态资源 + 三 meta 端点 + 路由可载入 ========== */
  {
    const st = [
      ['/', 'text/html; charset=utf-8'],
      ['/app.js', 'text/javascript; charset=utf-8'],
      ['/style.css', 'text/css; charset=utf-8'],
      ['/assets/echarts.min.js', 'text/javascript; charset=utf-8'],
    ];
    for (const [p, mime] of st) {
      const r = await fetch(base + p);
      const ct = r.headers.get('content-type') || '';
      const len = +(r.headers.get('content-length') || 0);
      check('D17-静态' + p + ' 200+MIME', r.status === 200 && ct === mime && len > 0, `ct=${ct} bytes=${len}`);
    }
    for (const id of ['dash-cockpit', 'dash-macro', 'dash-tech']) {
      const r = await get('/api/v1/meta/dashboard/' + id, 'leader');
      const ok = r.status === 200 && r.json.data.dashboardId === id && Array.isArray(r.json.data.charts) && r.json.data.charts.length >= 3;
      check('D17-看板' + id + '可载入(charts≥3)', ok, `charts=${r.json.data && r.json.data.charts && r.json.data.charts.length}`);
    }
    const nf = await get('/api/v1/meta/dashboard/dash-nope', 'leader');
    check('D17b-未知看板→404 DASHBOARD_NOT_FOUND', nf.status === 404 && nf.json.error.code === 'DASHBOARD_NOT_FOUND', `status=${nf.status}`);
    // 空数据态（D17：空数据显示走查的 API 前提）：口径不适用（ind_va 仅存于 C 门类）
    const empty = await q({
      metrics: ['MACRO.IND.VA0002'],
      dimensions: [{ dim: 'industry', granularity: 'industry_c2' }],
      filters: [{ dim: 'industry', op: 'in', values: ['I'] }],   // ind_va 仅存于 C
      time: { grain: 'month', range: ['2026-10', '2026-10'] },
    });
    const nullVals = empty.json.data.every((d) => d.metrics['MACRO.IND.VA0002'].value === null);
    check('D17c-口径不适用行value=null(200不报错)',
      empty.status === 200 && empty.json.data.length > 0 && nullVals,
      `rows=${empty.json.meta.rows} 全null=${nullVals}（口径不适用：组行保留 value=null，契约 §2.3 T09 修订）`);
  }

  /* ========== 认证与错误码边界（D2/D7 契约错误码表） ========== */
  {
    const no = await fetch(base + '/api/v1/query', { method: 'POST', body: JSON.stringify({ metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] } }) });
    const noJ = await no.json();
    check('AUTH-缺X-Role→401 UNAUTHENTICATED', no.status === 401 && noJ.error.code === 'UNAUTHENTICATED', `status=${no.status}`);
    const badRole = await fetch(base + '/api/v1/query', { method: 'POST', headers: { 'X-Role': 'admin' }, body: JSON.stringify({ metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] } }) });
    check('AUTHb-非法角色→401', badRole.status === 401, `status=${badRole.status}`);

    const oob = await q({ metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2023-01', '2023-02'] } });
    check('ERR-time.range越界→400 INVALID_TIME_RANGE', oob.status === 400 && oob.json.error.code === 'INVALID_TIME_RANGE', `status=${oob.status}`);
    const rev = await q({ metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-01'] } });
    check('ERRb-起>止→400 INVALID_TIME_RANGE', rev.status === 400 && rev.json.error.code === 'INVALID_TIME_RANGE', `status=${rev.status}`);
    const badVal = await q({ metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] }, filters: [{ dim: 'region', op: 'in', values: ['999999'] }] });
    check('ERRc-过滤值不在维表→400 BAD_FILTER', badVal.status === 400 && badVal.json.error.code === 'BAD_FILTER', `status=${badVal.status}`);
    const mixed = await q({ metrics: ['MACRO.GDP.GR0001', 'MACRO.CPI.IDX0003'], time: { grain: 'month', range: ['2026-10', '2026-10'] } });
    check('ERRd-跨事实表行族混查→400 DIM_MISMATCH', mixed.status === 400 && mixed.json.error.code === 'DIM_MISMATCH', `status=${mixed.status}`);
    const gran = await q({ metrics: ['MACRO.GDP.VA0001'], dimensions: [{ dim: 'region', granularity: 'industry_c1' }], time: { grain: 'month', range: ['2026-10', '2026-10'] } });
    check('ERRe-粒度×维度错配→400 DSL_SCHEMA_INVALID', gran.status === 400 && gran.json.error.code === 'DSL_SCHEMA_INVALID', `status=${gran.status}`);
  }

  /* ========== T25 · 预警契约（GET /api/v1/alerts，契约 09 §1） + T26 · Doris 编译契约（POST /api/v1/compile） ==========
   * 独立全新服务实例：D11 用例会 bump watermark/metricDef/dimTree，而 compile 黄金快照的注释头
   * 含 watermark/cacheKey（缓存键四因子），必须锚定初始版本状态，逐字节断言才可复现。 */
  {
    const app2 = await startServer({ port: 0, quiet: true });
    const base2 = 'http://127.0.0.1:' + app2.port;
    try {
      const get2 = async (p, role) => {
        const r = await fetch(base2 + p, { headers: role ? { 'X-Role': role } : {} });
        return { status: r.status, json: await r.json().catch(() => null) };
      };
      const post2 = async (p, body, role) => {
        const r = await fetch(base2 + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Role': role || 'leader' }, body: JSON.stringify(body) });
        return { status: r.status, json: await r.json().catch(() => null) };
      };

      /* ---- T25 预警清单（服务端实时计算；预埋 A1/A2/A3 必须覆盖） ---- */
      {
        const r = await get2('/api/v1/alerts', 'leader');
        const j = r.json;
        const items = j.items || [];
        const jsInd = items.find((i) => i.regionCode === '320000' && i.metricCode === 'MACRO.IND.VA0002');
        check('T25①-leader默认asof=水位月2026-10且含江苏规上工业danger、months≥5(预埋A1)',
          r.status === 200 && j.asof === '2026-10' && j.watermark === 'wm-20261108-01' && !isNaN(Date.parse(j.computedAt)) &&
          !!jsInd && jsInd.level === 'danger' && jsInd.months >= 5 && jsInd.yoy < 0 &&
          jsInd.province === '江苏省' && jsInd.region === '江苏' && typeof jsInd.metricName === 'string',
          `asof=${j.asof} items=${items.length} A1=${JSON.stringify(jsInd)}`);
        const jsEngi = items.find((i) => i.regionCode === '320000' && i.metricCode === 'MACRO.ENGI.GR0009');
        check('T25②-能耗逆指标预警在列(预埋A2:2026-08起连续3月劣化→danger,逆语义=读数<0)',
          !!jsEngi && jsEngi.months === 3 && jsEngi.yoy === -7.46 && jsEngi.level === 'danger',
          `A2=${JSON.stringify(jsEngi)}`);
        check('T25③-条目结构字段齐全且取值域合法(契约响应Schema)',
          items.length > 0 && items.every((i) => typeof i.province === 'string' && /^\d{6}$/.test(i.regionCode) &&
            typeof i.region === 'string' && /^(MACRO|TECH)\.[A-Z0-9_]+\.[A-Z0-9]{6,8}$/.test(i.metricCode) &&
            typeof i.metricName === 'string' && typeof i.yoy === 'number' &&
            (i.level === 'danger' || i.level === 'warning') && Number.isInteger(i.months) && i.months >= 1),
          `items=${items.length}`);
        /* 预埋 A3：江苏 GDP 累计增速 3.88% 五省严格末位（2026-09 起，2026-08 为广东 4.37）→ 垫底 warning，连续 2 月 */
        const jsGdp = items.find((i) => i.regionCode === '320000' && i.metricCode === 'MACRO.GDP.GR0001');
        check('T25③b-预埋A3江苏GDP增速垫底→warning(yoy=3.88,连续垫底2月)',
          !!jsGdp && jsGdp.level === 'warning' && jsGdp.yoy === 3.88 && jsGdp.months === 2 &&
          items.filter((i) => i.metricCode === 'MACRO.GDP.GR0001').length === 1,
          `A3=${JSON.stringify(jsGdp)}`);
        const pj = await get2('/api/v1/alerts', 'prov-js');
        check('T25④-RLS:prov-js只见江苏且仍含A1 danger(全国视角同构)',
          pj.status === 200 && pj.json.items.length > 0 && pj.json.items.every((i) => i.regionCode === '320000') &&
          pj.json.items.some((i) => i.metricCode === 'MACRO.IND.VA0002' && i.level === 'danger' && i.months >= 5),
          `items=${pj.json.items.length} 省集=${[...new Set(pj.json.items.map((i) => i.regionCode))].join(',')}`);
        const pg = await get2('/api/v1/alerts', 'prov-gd');
        check('T25④b-RLS:prov-gd只见广东', pg.status === 200 && pg.json.items.every((i) => i.regionCode === '440000'),
          `items=${pg.json.items.length}`);
        const sep = await get2('/api/v1/alerts?asof=2026-09', 'leader');
        const s9ind = (sep.json.items || []).find((i) => i.regionCode === '320000' && i.metricCode === 'MACRO.IND.VA0002');
        const s9engi = (sep.json.items || []).find((i) => i.regionCode === '320000' && i.metricCode === 'MACRO.ENGI.GR0009');
        check('T25⑤-asof参数生效:2026-09回看A1 months=4仍danger、A2 months=2降级warning',
          sep.status === 200 && sep.json.asof === '2026-09' && s9ind && s9ind.months === 4 && s9ind.level === 'danger' &&
          s9engi && s9engi.months === 2 && s9engi.level === 'warning',
          `IND=${s9ind && s9ind.months}/${s9ind && s9ind.level} ENGI=${s9engi && s9engi.months}/${s9engi && s9engi.level}`);
        /* A3 回看：2026-09 江苏首月垫底（4.12 严格末位）→ months=1 */
        const s9gdp = (sep.json.items || []).find((i) => i.regionCode === '320000' && i.metricCode === 'MACRO.GDP.GR0001');
        check('T25⑤b-2026-09垫底回看:江苏连续垫底1月(yoy=4.12,warning)',
          !!s9gdp && s9gdp.months === 1 && s9gdp.yoy === 4.12 && s9gdp.level === 'warning',
          `A3=${JSON.stringify(s9gdp)}`);
        const no = await fetch(base2 + '/api/v1/alerts');
        check('T25⑥-缺X-Role→401 UNAUTHENTICATED', no.status === 401 && (await no.json()).error.code === 'UNAUTHENTICATED', `status=${no.status}`);
        const bad = await get2('/api/v1/alerts?asof=2026-13', 'leader');
        const oob = await get2('/api/v1/alerts?asof=2027-01', 'leader');
        check('T25⑦-asof格式非法→400 DSL_SCHEMA_INVALID/越界→400 INVALID_TIME_RANGE(10错误码体系)',
          bad.status === 400 && bad.json.error.code === 'DSL_SCHEMA_INVALID' && oob.status === 400 && oob.json.error.code === 'INVALID_TIME_RANGE',
          `fmt=${bad.status}/${bad.json.error && bad.json.error.code} oob=${oob.status}/${oob.json.error && oob.json.error.code}`);
      }

      /* ---- T26 compile 端点契约 ---- */
      {
        const dsl1 = { metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] } };
        const r1 = await post2('/api/v1/compile', dsl1);
        check('T26①-compile 200:{sql,dialect=doris,executor,cacheKey=sha256:…,warnings[]}',
          r1.status === 200 && typeof r1.json.sql === 'string' && r1.json.dialect === 'doris' &&
          ['local', 'doris', 'shadow'].includes(r1.json.executor) && /^sha256:[0-9a-f]{64}$/.test(r1.json.cacheKey) &&
          Array.isArray(r1.json.warnings), `executor=${r1.json.executor} warnings=${r1.json.warnings.length}`);
        const r1b = await post2('/api/v1/compile', dsl1);
        check('T26①b-同DSL重复编译SQL逐字节一致(编译器确定性)',
          r1b.status === 200 && r1b.json.sql === r1.json.sql && r1b.json.cacheKey === r1.json.cacheKey, `len=${r1.json.sql.length}`);
        check('T26①c-注释头 /* watermark=… cacheKey=… role=… */',
          /^\/\* watermark=wm-20261108-01 cacheKey=sha256:[0-9a-f]{64} role=leader \*\/\n/.test(r1.json.sql),
          r1.json.sql.split('\n')[0]);
        check('T26①d-物理表映射dwd_stat_fact+period列+LIMIT兜底',
          /FROM dwd_stat_fact/.test(r1.json.sql) && /period = '2026-10'/.test(r1.json.sql) && /LIMIT 50$/.test(r1.json.sql), '');
        const noRole = await fetch(base2 + '/api/v1/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dsl1) });
        const badM = await post2('/api/v1/compile', { metrics: ['MACRO.GDP.XX9999'], time: { grain: 'month', range: ['2026-10', '2026-10'] } });
        const badF = await post2('/api/v1/compile', { metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-01'] } });
        const badC = await post2('/api/v1/compile', { metrics: ['MACRO.INV.CU0004'], time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['mom'] } });
        check('T26①e-同Schema同错误码:缺Role→401/未注册→404/时间逆→400/策略冲突→403',
          noRole.status === 401 && badM.status === 404 && badM.json.error.code === 'METRIC_NOT_FOUND' &&
          badF.status === 400 && badF.json.error.code === 'INVALID_TIME_RANGE' &&
          badC.status === 403 && badC.json.error.code === 'COMPARE_POLICY_FORBIDDEN',
          `401=${noRole.status} 404=${badM.status} 400=${badF.status} 403=${badC.status}`);
        const pj = await post2('/api/v1/compile', { metrics: ['MACRO.GDP.VA0001'], dimensions: [{ dim: 'region', granularity: 'city' }], time: { grain: 'month', range: ['2026-10', '2026-10'] } }, 'prov-js');
        check('T26①f-RLS编译期注入(prov-js→region_prov=320000)+层级冗余列零JOIN',
          pj.status === 200 && /region_prov = '320000'/.test(pj.json.sql) && /GROUP BY region_city/.test(pj.json.sql) && !/\bJOIN\b/i.test(pj.json.sql), '');
        const lim = await post2('/api/v1/compile', { metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] }, limit: 1000 });
        check('T26①g-body.limit透传SQL LIMIT(1..1000域内)', lim.status === 200 && /LIMIT 1000$/.test(lim.json.sql), lim.json.sql.split('\n').pop());
      }

      /* ---- T26 黄金 SQL 快照 4 组（固定 DSL → SQL 逐字一致，编译器黄金测试） ---- */
      {
        const GOLDEN = [
          ['S1总览(双sum指标无维度)',
            { metrics: ['MACRO.GDP.VA0001', 'MACRO.TRADE.VA0006'], time: { grain: 'month', range: ['2026-10', '2026-10'] } }, 'leader',
            /* S1 */ "/* watermark=wm-20261108-01 cacheKey=sha256:13dd6e01b6d6f34a481972a5f68abe4309a6420676921793d7e0b32743b3f7c0 role=leader */\nSELECT SUM(CASE WHEN period = '2026-10' THEN gdp_va END) AS m1, SUM(CASE WHEN period = '2026-10' THEN trade_va END) AS m2\nFROM dwd_stat_fact\nWHERE ind_c2 IS NOT NULL\n  AND period = '2026-10'\nORDER BY m1 DESC\nLIMIT 50"],
          ['S2province下钻(descendantOf+显式排序)',
            { metrics: ['MACRO.GDP.VA0001'], dimensions: [{ dim: 'region', granularity: 'province' }], filters: [{ dim: 'region', op: 'descendantOf', value: '320000' }], time: { grain: 'month', range: ['2026-10', '2026-10'] }, sort: [{ by: 'MACRO.GDP.VA0001', order: 'desc' }] }, 'leader',
            /* S2 */ "/* watermark=wm-20261108-01 cacheKey=sha256:c4d60e5d0e69c0b86c60ddcf05e43a9c6a10d04539f2721210700b2b3ce7c31e role=leader */\nSELECT region_prov AS dim_region, SUM(CASE WHEN period = '2026-10' THEN gdp_va END) AS m1\nFROM dwd_stat_fact\nWHERE ind_c2 IS NOT NULL\n  AND region_prov = '320000'\n  AND period = '2026-10'\nGROUP BY region_prov\nORDER BY m1 DESC\nLIMIT 50"],
          ['S3city粒度(prov-js RLS+行业IN过滤)',
            { metrics: ['MACRO.IND.VA0002'], dimensions: [{ dim: 'region', granularity: 'city' }], filters: [{ dim: 'industry', op: 'in', values: ['C'] }], time: { grain: 'month', range: ['2026-10', '2026-10'] } }, 'prov-js',
            /* S3 */ "/* watermark=wm-20261108-01 cacheKey=sha256:2506c93f136783a8a5acb00d11696b68238f00f17491f21c87bc4416e7eb445e role=prov-js */\nSELECT region_city AS dim_region, SUM(CASE WHEN period = '2026-10' THEN ind_va END) AS m1\nFROM dwd_stat_fact\nWHERE ind_c2 IS NOT NULL\n  AND region_prov = '320000'\n  AND ind_c1 IN ('C')\n  AND period = '2026-10'\nGROUP BY region_city\nORDER BY region_city ASC, m1 DESC\nLIMIT 50"],
          ['S4ratio+同比(compare_then_compute双窗口,契约§2示例窗口)',
            { metrics: ['MACRO.GDP.GR0001'], dimensions: [{ dim: 'region', granularity: 'province' }], time: { grain: 'month', range: ['2026-01', '2026-09'], compare: ['yoy'] } }, 'leader',
            /* S4 */ "/* watermark=wm-20261108-01 cacheKey=sha256:5f373ebdbfdff85ef26f6b8f3de2be94f49a330dadc02db4d29ff399355531e2 role=leader */\nSELECT region_prov AS dim_region, (SUM(CASE WHEN period >= '2026-01' AND period <= '2026-09' THEN gdp_va END) / NULLIF(SUM(CASE WHEN period >= '2026-01' AND period <= '2026-09' THEN gdp_va_py END), 0) - 1) * 100 AS m1, (SUM(CASE WHEN period >= '2025-01' AND period <= '2025-09' THEN gdp_va END) / NULLIF(SUM(CASE WHEN period >= '2025-01' AND period <= '2025-09' THEN gdp_va_py END), 0) - 1) * 100 AS m1_yoy_base\nFROM dwd_stat_fact\nWHERE ind_c2 IS NOT NULL\n  AND period >= '2025-01' AND period <= '2026-09'\nGROUP BY region_prov\nORDER BY region_prov ASC, m1 DESC\nLIMIT 50"],
        ];
        for (const [name, dsl, role, expect] of GOLDEN) {
          const r = await post2('/api/v1/compile', dsl, role);
          check('T26②-黄金快照' + name + '逐字一致',
            r.status === 200 && r.json.sql === expect,
            r.status === 200 ? (r.json.sql === expect ? '' : '实际=' + JSON.stringify(r.json.sql)) : `status=${r.status}`);
        }
      }

      /* ---- T26 meta.execution + debug 双通道 ---- */
      {
        const qd = await post2('/api/v1/query', { metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] } });
        const ex = qd.json.meta && qd.json.meta.execution;
        check('T26③-query响应meta.execution={backend,sqlHash,durMs}',
          qd.status === 200 && !!ex && ex.backend === 'local' && /^sha256:[0-9a-f]{64}$/.test(ex.sqlHash) &&
          typeof ex.durMs === 'number' && ex.durMs >= 0, JSON.stringify(ex));
        const qb = await post2('/api/v1/query', { metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] }, debug: 1 });
        const qu = await fetch(base2 + '/api/v1/query?debug=1', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Role': 'leader' }, body: JSON.stringify({ metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] } }) });
        const quJ = await qu.json();
        check('T26③b-debug=1双通道(body/URL)→200且meta.sql全文可观测(v0.1兼容常附)',
          qb.status === 200 && qu.status === 200 && typeof qb.json.meta.sql === 'string' && qb.json.meta.sql.length > 0 &&
          typeof quJ.meta.sql === 'string' && quJ.meta.sql.length > 0, `body=${qb.status} url=${qu.status}`);

        /* ---- T30 · meta.execution 扩展断言（契约 09 §6：新增 ≥2） ---- */
        const sqlSha = require('crypto').createHash('sha256').update(qd.json.meta.sql, 'utf8').digest('hex');
        check('T30②-sqlHash=sha256(实际执行的meta.sql全文)且backend=local(哈希绑定观测SQL,可对账)',
          /^sha256:[0-9a-f]{64}$/.test(ex.sqlHash) && ex.sqlHash === 'sha256:' + sqlSha && ex.backend === 'local' &&
          typeof qd.json.meta.sql === 'string' && qd.json.meta.sql.length > 0,
          `sqlHash=${ex.sqlHash.slice(0, 22)}… 重算=${'sha256:' + sqlSha.slice(0, 22)}…`);
        const qAgain = await post2('/api/v1/query', { metrics: ['MACRO.GDP.VA0001'], time: { grain: 'month', range: ['2026-10', '2026-10'] } });
        const qOther = await post2('/api/v1/query', { metrics: ['MACRO.TRADE.VA0006'], time: { grain: 'month', range: ['2026-10', '2026-10'] } });
        check('T30②b-sqlHash确定性+敏感性:同DSL重复查询同哈希/异DSL哈希互异',
          qAgain.json.meta.execution.sqlHash === ex.sqlHash && qOther.json.meta.execution.sqlHash !== ex.sqlHash &&
          /^sha256:[0-9a-f]{64}$/.test(qOther.json.meta.execution.sqlHash),
          `again=${qAgain.json.meta.execution.sqlHash.slice(0, 18)}… other=${qOther.json.meta.execution.sqlHash.slice(0, 18)}…`);
        const qRatio = await post2('/api/v1/query', { metrics: ['MACRO.GDP.GR0001'], dimensions: [{ dim: 'region', granularity: 'province' }], time: { grain: 'month', range: ['2026-10', '2026-10'], compare: ['yoy'] } }, 'prov-js');
        const exR = qRatio.json.meta && qRatio.json.meta.execution;
        check('T30②c-ratio+RLS形态meta.execution保形:backend=local/durMs数字/hash合法/rlsRole回显',
          qRatio.status === 200 && !!exR && exR.backend === 'local' && typeof exR.durMs === 'number' && exR.durMs >= 0 &&
          /^sha256:[0-9a-f]{64}$/.test(exR.sqlHash) && qRatio.json.meta.rlsRole === 'prov-js', JSON.stringify(exR));
      }

      /* ---- T26 Executor 抽象：env 矩阵（getExecutor 单元断言） ---- */
      {
        const saved = {};
        for (const k of ['DORIS_FE', 'DORIS_USER', 'DORIS_PASS', 'DORIS_DB', 'DORIS_SHADOW']) { saved[k] = process.env[k]; delete process.env[k]; }
        try {
          check('T26④①-env缺省→executor=local(黄金路径保底)', dorisMod.getExecutor().mode === 'local', '');
          process.env.DORIS_FE = 'http://127.0.0.1:8030'; process.env.DORIS_USER = 'u'; process.env.DORIS_PASS = 'p';
          check('T26④②-三env缺DORIS_DB→仍local(四env全配置才启用doris)', dorisMod.getExecutor().mode === 'local', '');
          process.env.DORIS_DB = 'dbg';
          check('T26④③-四env全配置→doris', dorisMod.getExecutor().mode === 'doris', '');
          process.env.DORIS_SHADOW = '1';
          check('T26④④-DORIS_SHADOW=1(且FE配置)→shadow双跑对账', dorisMod.getExecutor().mode === 'shadow', '');
          delete process.env.DORIS_FE;
          check('T26④⑤-shadow缺FE→回退local', dorisMod.getExecutor().mode === 'local', '');
        } finally {
          for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        }
      }

      /* ---- T26 NDJSON 解析 + FE 行映射（fixture 单元断言，不依赖真实 FE） ---- */
      {
        const nd = dorisMod.parseNdjson('{"dim_region":"320000","m1":10.5,"m1_yoy_base":9.9}\n\n{"dim_region":"440000","m1":null}\n');
        check('T26⑤-NDJSON逐行解析(空行跳过/容尾换行)', nd.length === 2 && nd[0].m1 === 10.5 && nd[1].m1 === null, `rows=${nd.length}`);
        const fakeReg = { nodeIdx: { region: new Map([['320000', { code: '320000', name: '江苏省', path: '/320000/' }], ['440000', { code: '440000', name: '广东省', path: '/440000/' }]]) } };
        const fakeRt = { code: { code: 'MACRO.GDP.VA0001', name: 'GDP（当月值）' }, policy: 'direct', kind: 'sum' };
        const mapped = dorisMod.mapDorisRows(nd, { reg: fakeReg, rts: [fakeRt], dimensions: [{ dim: 'region', granularity: 'province' }], compares: ['yoy'], aliasMap: dorisMod.aliasMapOf([fakeRt]) });
        const m0 = mapped[0].metrics['MACRO.GDP.VA0001'];
        check('T26⑤b-FE行映射→契约形状(维表解码+delta/rate引擎同式现算)',
          mapped[0].dims.region.name === '江苏省' && mapped[0].dims.region.path === '/320000/' && m0.value === 10.5 &&
          m0.yoy.base === 9.9 && m0.yoy.delta === 0.6 && Math.abs(m0.yoy.rate - 0.6 / 9.9) < 1e-4,
          JSON.stringify(m0));
        check('T26⑤c-当期口径缺失(null)→空同比子对象缺省(引擎同语义)', mapped[1].metrics['MACRO.GDP.VA0001'].yoy === undefined, '');
      }

      /* ---- T26 窗口漂移守卫：doris.js ratio 模板窗口 === 引擎 metricWindow（防双处维护漂移） ---- */
      {
        const specs = dorisMod.getRatioSqlSpecs(shiftMonth);
        const same4 = ['MACRO.GDP.GR0001', 'MACRO.CPI.IDX0003', 'MACRO.ENGI.GR0009', 'TECH.PAT.SH0004'];
        let allSame = true;
        for (const code of same4) {
          for (const off of [0, -12, -1]) {
            for (const [m0, m1] of [['2026-10', '2026-10'], ['2026-01', '2026-09'], ['2025-06', '2026-03']]) {
              const exp = metricWindow({ kind: 'ratio', code: { code } }, m0, m1, off);
              for (const f of specs[code].fields) {
                const got = f.win(m0, m1, off);
                if (got[0] !== exp[0] || got[1] !== exp[1]) allSame = false;
              }
            }
          }
        }
        check('T26⑥-窗口漂移守卫:4个ratio模板字段窗口===引擎metricWindow(3月样例×3偏移)', allSame, '');
        const intSpec = specs['TECH.RD.INT0002'];
        const e12 = shiftMonth('2026-09', -12);
        const numOk = JSON.stringify(intSpec.fields[0].win('2026-01', '2026-09', -12)) === JSON.stringify([e12, e12]);
        const denOk = JSON.stringify(intSpec.fields[1].win('2026-01', '2026-09', -12)) ===
          JSON.stringify(metricWindow({ kind: 'ratio', code: { code: 'TECH.RD.INT0002' } }, '2026-01', '2026-09', -12));
        check('T26⑥b-INT0002分子末月单月窗/分母ytd窗与引擎calc窗口一致', numOk && denOk,
          `num=${JSON.stringify(intSpec.fields[0].win('2026-01', '2026-09', -12))}`);
      }

      /* ---- T26 编译器直调：LIMIT 兜底 + 脱敏投影层 mask()（契约 §2） ---- */
      {
        const rtStub = { kind: 'sum', field: 'gdp_va', policy: 'direct', family: 'ind', code: { code: 'MACRO.GDP.VA0001', data_level: '一般' } };
        const helpers = { shiftMonth, metricWindow };
        const out = dorisMod.compileDorisSql({
          body: { metrics: ['MACRO.GDP.VA0001'], dimensions: [], filters: [], time: { grain: 'month', range: ['2026-01', '2026-09'], compare: ['yoy'] }, sort: [], limit: 5000 },
          rts: [rtStub], family: 'ind', reg: {}, role: 'leader', roleDef: { rls: { type: 'allow_all' } },
          watermark: 'wm-test', cacheKey: 'sha256:test', helpers,
        });
        check('T26⑦-LIMIT兜底2000(超限截断)+一般数据级无脱敏warning',
          /LIMIT 2000$/.test(out.sql) && out.warnings.length === 0, `tail=${out.sql.slice(-11)}`);
        const rtSens = { kind: 'sum', field: 'gdp_va', policy: 'direct', family: 'ind', code: { code: 'MACRO.SEC.VA0001', data_level: '敏感' } };
        const out2 = dorisMod.compileDorisSql({
          body: { metrics: ['MACRO.SEC.VA0001'], dimensions: [], filters: [], time: { grain: 'month', range: ['2026-10', '2026-10'], compare: [] }, sort: [], limit: 50 },
          rts: [rtSens], family: 'ind', reg: {}, role: 'leader', roleDef: { rls: { type: 'allow_all' } },
          watermark: 'wm-test', cacheKey: 'sha256:t2', helpers,
        });
        check('T26⑦b-脱敏在投影层:非一般数据级→mask()包裹+登记warning',
          /mask\(SUM\(/.test(out2.sql) && out2.warnings.length === 1 && /^MASK_APPLIED:/.test(out2.warnings[0]),
          out2.warnings.join(';'));
      }
    } finally {
      app2.server.close();
    }
  }

  /* ========== T29 · 报告导出端点（GET /api/v1/report，契约 09 §3） ==========
   * 独立全新服务实例：role 走 query 参数（报告页无 header 通道），不传 X-Role。 */
  {
    const app3 = await startServer({ port: 0, quiet: true });
    const base3 = 'http://127.0.0.1:' + app3.port;
    try {
      const rep = async (query) => {
        const r = await fetch(base3 + '/api/v1/report' + query); // 故意不带 X-Role：报告页 role 只认 query
        return { status: r.status, text: await r.text(), headers: r.headers };
      };
      const r1 = await rep('?dashboard=cockpit&role=leader');
      const t1 = r1.text;
      check('T29①-report 200+Content-Type含text/html 且标题区/四大章节齐全(看板名+asof+生成时间+角色水印)',
        r1.status === 200 && (r1.headers.get('content-type') || '').includes('text/html') &&
        t1.includes('宏观经济运行驾驶舱') && t1.includes('核心数值表') && t1.includes('省份排名表') &&
        t1.includes('预警清单') && t1.includes('生成时间') && t1.includes('leader 视角') && t1.includes('2026-10'),
        `ct=${r1.headers.get('content-type')} bytes=${t1.length}`);
      check('T29②-指标口径脚注章节:含 MACRO.GDP.VA0001 + meta 语义说明 + 表下口径见脚注[n] + 打印按钮/@media print',
        t1.includes('指标口径脚注') && t1.includes('MACRO.GDP.VA0001') && t1.includes('口径见脚注') &&
        t1.includes('agg_type_defs') && t1.includes('compare_policy_defs') &&
        t1.includes('window.print') && t1.includes('@media print'),
        `fn锚=${(t1.match(/id="fn-\d+"/g) || []).length}`);
      check('T29③-leader全国视角:核心数值表8指标卡+省份排名表含5省(服务端实算)',
        (t1.match(/<tr>/g) || []).length > 10 && t1.includes('江苏省') && t1.includes('广东省') &&
        t1.includes('浙江省') && t1.includes('山东省') && t1.includes('贵州省'),
        `tr=${(t1.match(/<tr>/g) || []).length}`);
      const pj = await rep('?dashboard=cockpit&role=prov-js');
      check('T29④-RLS:role=prov-js 报告数据仅含江苏(排名表省份集合),其他省不出现',
        pj.status === 200 && pj.text.includes('江苏省') && pj.text.includes('prov-js 视角') &&
        !pj.text.includes('广东省') && !pj.text.includes('浙江省') && !pj.text.includes('山东省') && !pj.text.includes('贵州'),
        `江苏=${pj.text.includes('江苏省')} 广东=${pj.text.includes('广东省')} 浙江=${pj.text.includes('浙江省')}`);
      const a9 = await rep('?dashboard=cockpit&role=leader&asof=2026-09');
      check('T29⑤-asof显式传参生效(标题区数据期=2026-09)', a9.status === 200 && a9.text.includes('数据期（asof）：2026-09'), '');
      const tech = await rep('?dashboard=dash-tech&role=leader');
      check('T29⑥-dash-tech报告含科技看板名与排名指标 TECH.PAT.VA0003',
        tech.status === 200 && tech.text.includes('科技创新主题看板') && tech.text.includes('TECH.PAT.VA0003'), '');
      const macro = await rep('?dashboard=dash-macro&role=leader');
      check('T30①-BUG-T30-1修复:dash-macro报告200且含宏观经济主题看板名(前端导出按钮联调对齐)',
        macro.status === 200 && macro.text.includes('宏观经济主题看板') && macro.text.includes('核心数值表'),
        `status=${macro.status} bytes=${macro.text.length}`);
      const badA = await rep('?dashboard=cockpit&role=leader&asof=2026-13');
      const badB = await rep('?dashboard=cockpit&role=leader&asof=2027-01');
      const badC = await rep('?dashboard=nope&role=leader');
      const badD = await rep('?dashboard=cockpit&role=admin');
      const badE = await rep('?dashboard=cockpit');
      check('T29⑦-非法asof格式/越界/非法dashboard/非法role/缺role→400(DSL_SCHEMA_INVALID|INVALID_TIME_RANGE)',
        badA.status === 400 && badA.text.includes('DSL_SCHEMA_INVALID') &&
        badB.status === 400 && badB.text.includes('INVALID_TIME_RANGE') &&
        badC.status === 400 && badD.status === 400 && badE.status === 400,
        `fmt=${badA.status} oob=${badB.status} dash=${badC.status} role=${badD.status} noRole=${badE.status}`);
    } finally {
      app3.server.close();
    }
  }

  /* ---- 汇总与收尾 ---- */
  console.log(`\n[tests] 结果：${pass}/${pass + fail} 通过` + (fail ? `（失败 ${fail} 项）` : '（全部通过）'));
  server.close();
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 300);
}

main().catch((e) => { console.error('[tests] 运行异常：', e); process.exit(1); });

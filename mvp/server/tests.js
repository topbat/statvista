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
const { startServer } = require('./index.js');

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

  /* ---- 汇总与收尾 ---- */
  console.log(`\n[tests] 结果：${pass}/${pass + fail} 通过` + (fail ? `（失败 ${fail} 项）` : '（全部通过）'));
  server.close();
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 300);
}

main().catch((e) => { console.error('[tests] 运行异常：', e); process.exit(1); });

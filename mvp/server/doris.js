'use strict';
/**
 * ============================================================================
 * T26 · Doris 方言编译器 + 执行后端 Executor 抽象（零依赖，仅内置模块）
 * 契约依据：docs/mvp/09-v0.2契约冻结.md §2（Doris 编译契约）
 *
 * 职责：
 *   ① getExecutor()：按 env 选择执行后端——
 *      local（默认）/ doris（DORIS_FE+DORIS_USER+DORIS_PASS+DORIS_DB 四 env 全配置）/
 *      shadow（DORIS_SHADOW=1 且 DORIS_FE 配置：双跑对账，local 恒为主路径）
 *   ② compileDorisSql()：规范化 QueryRequest → Doris 方言 SQL（确定性：同输入逐字节同输出）
 *      - 物理表映射：facts → dwd_stat_fact（单表，period 月份列 + region/ind 层级冗余列）
 *      - 层级列零 JOIN：grain=province → GROUP BY region_prov（冗余列等值/IN 过滤）
 *      - RLS WHERE 编译期注入（与 index.js executeQuery 同一 roleDef 语义）
 *      - ratio 指标 = SUM(num)/SUM(den) 现算（NULLIF 防除零，与引擎 null 语义一致）
 *      - 同比/环比 = 双窗口：主窗 CASE + 基窗 CASE（sum 用平移窗，ratio 用 *_py 列同窗重算，
 *        与引擎 metricWindow/RATIO_SPECS 逐一对齐——漂移由 tests.js 窗口守卫断言双保险）
 *      - LIMIT 兜底 2000；注释头 /* watermark=… cacheKey=… role=… *​/
 *   ③ executeOnDoris()：Doris FE REST（POST {DORIS_FE}/api/query/{db}，Basic auth，
 *      Accept: application/vnd.doris.query+json;v=1，body {stmt: sql}）+ NDJSON 流式解析
 *   ④ mapDorisRows()/sortLimitData()/diffData()：FE 行 → 契约响应形状（引擎同式舍入、
 *      排序、limit、空同比语义），shadow 双跑对账 diff
 *
 * 依赖注入（防循环依赖）：本模块不 require('./index.js')。引擎窗口原语
 * （shiftMonth/metricWindow）与注册表（reg.nodeIdx 等）由调用方以 helpers/reg 参数注入；
 * ratio SQL 投影模板（getRatioSqlSpecs）内嵌于本模块，与 index.js RATIO_SPECS 的
 * 一致性由 tests.js「窗口漂移守卫」断言锁定。
 * ============================================================================
 */

const http = require('http');

/* ================================ 1. Executor 选择 ================================ */

/**
 * 按 env 解析执行后端（每次调用现读，测试可注入 env 对象）
 * 返回 { mode: 'local'|'doris'|'shadow', fe, user, pass, db, dorisReady }
 */
function resolveExecutor(env) {
  const fe = env.DORIS_FE || '';
  const user = env.DORIS_USER || '';
  const pass = env.DORIS_PASS || '';
  const db = env.DORIS_DB || '';
  const dorisReady = !!(fe && user && pass && db);
  if (env.DORIS_SHADOW === '1' && fe) return { mode: 'shadow', fe, user, pass, db, dorisReady };
  if (dorisReady) return { mode: 'doris', fe, user, pass, db, dorisReady };
  return { mode: 'local', fe: '', user: '', pass: '', db: '', dorisReady: false };
}

/** 执行后端选择入口（读 process.env；local 恒为默认与黄金值保底路径） */
function getExecutor() {
  return resolveExecutor(process.env);
}

/* ================================ 2. 物理模型常量 ================================ */

const DORIS_TABLE = 'dwd_stat_fact'; // 契约 §2：facts 物理表映射
const LIMIT_CAP = 2000;              // 契约 §2：LIMIT 2000 兜底

// 逻辑维度粒度 → dwd_stat_fact 物理列（层级冗余列，零 JOIN；period=月份列）
const DORIS_GRAN_COL = {
  'region|province': 'region_prov',
  'region|city': 'region_city',
  'industry|industry_c1': 'ind_c1',
  'industry|industry_c2': 'ind_c2',
  'time|time_month': 'period',
};

/* ================================ 3. SQL 片段工具（确定性格式） ================================ */

/** 字面量加引号（取值域已由 normalizeQuery 校验：编码/维表值/月份；防御性再转义单引号） */
const q1 = (s) => "'" + String(s).replace(/'/g, "''") + "'";
/** 月份窗口谓词：单月用等值，区间用 >=/<=（契约 §2 示例格式） */
const winSql = (s, e) => (s === e ? `period = ${q1(s)}` : `period >= ${q1(s)} AND period <= ${q1(e)}`);
/** 窗口守卫加和：SUM(CASE WHEN <窗口> THEN <列> END)——无行/窗外均为 NULL，与引擎"字段缺失即口径不适用"一致 */
const caseSum = (field, s, e) => `SUM(CASE WHEN ${winSql(s, e)} THEN ${field} END)`;

/* ================================ 4. ratio 指标 SQL 投影模板 ================================ */

/**
 * ratio 型指标（compare_then_compute）的 Doris 投影模板——与 index.js RATIO_SPECS 一一对应：
 *   fields[i].win(m0, m1, off) → [s, e]：该分子/分母列的实际聚合窗（与引擎 calc 内 sumField 窗口一致）
 *   expr(F) → 该指标的现算表达式（F[i] = 第 i 列的主/基窗 CASE 加和；NULLIF 对齐引擎除零→null）
 * 窗口语义漂移由 tests.js「窗口漂移守卫」对照 index.js metricWindow/RATIO_SPECS 锁定。
 * @param {(ym:string,k:number)=>string} shift 引注入的月份平移原语
 */
function getRatioSqlSpecs(shift) {
  // ytd 窗：off 平移后所在年的 1 月 → 该月（GR0001/INT0002 分母口径）
  const YTD = (m0, m1, off) => { const e = shift(m1, off); return [e.slice(0, 4) + '-01', e]; };
  // 月区间窗：[m0,m1] 整体平移（IDX0003/GR0009/SH0004）
  const MON = (m0, m1, off) => [shift(m0, off), shift(m1, off)];
  // 末月单月窗（INT0002 分子：入库即累计，取末月点值）
  const END = (m0, m1, off) => { const e = shift(m1, off); return [e, e]; };
  return {
    // GDP 累计同比增速：(ytd(gdp_va)/ytd(gdp_va_py) - 1) × 100
    'MACRO.GDP.GR0001': {
      fields: [{ col: 'gdp_va', win: YTD }, { col: 'gdp_va_py', win: YTD }],
      expr: (F) => `(${F[0]} / NULLIF(${F[1]}, 0) - 1) * 100`,
    },
    // CPI 当月同比：(Σcpi_lvl / Σcpi_lvl_py - 1) × 100
    'MACRO.CPI.IDX0003': {
      fields: [{ col: 'cpi_lvl', win: MON }, { col: 'cpi_lvl_py', win: MON }],
      expr: (F) => `(${F[0]} / NULLIF(${F[1]}, 0) - 1) * 100`,
    },
    // 单位GDP能耗降低率：(1 - (Σeng/Σgdp)/(Σeng_py/Σgdp_py)) × 100（逆指标）
    'MACRO.ENGI.GR0009': {
      fields: [{ col: 'eng_con', win: MON }, { col: 'gdp_va', win: MON }, { col: 'eng_con_py', win: MON }, { col: 'gdp_va_py', win: MON }],
      expr: (F) => `(1 - (${F[0]} / NULLIF(${F[1]}, 0)) / NULLIF(${F[2]} / NULLIF(${F[3]}, 0), 0)) * 100`,
    },
    // R&D 投入强度：rd_cu@末月 / ytd(gdp_va) × 100
    'TECH.RD.INT0002': {
      fields: [{ col: 'rd_cu', win: END }, { col: 'gdp_va', win: YTD }],
      expr: (F) => `(${F[0]} / NULLIF(${F[1]}, 0)) * 100`,
    },
    // 发明专利授权占比：Σpat_inv / Σpat_va × 100
    'TECH.PAT.SH0004': {
      fields: [{ col: 'pat_inv', win: MON }, { col: 'pat_va', win: MON }],
      expr: (F) => `(${F[0]} / NULLIF(${F[1]}, 0)) * 100`,
    },
  };
}

/* ================================ 5. 过滤编译（period/冗余列，零 JOIN） ================================ */

/**
 * 规范化过滤树 → Doris WHERE 片段（与 index.js compileNode/compileLeaf 等价，
 * 列名映射到 dwd_stat_fact 物理列：month→period；descendantOf 同样按节点层级等值编译）
 */
function compileFilter(reg, n) {
  if (n.comb === 'not') return `NOT (${compileFilter(reg, n.child)})`;
  if (n.comb) {
    const cs = n.children.map((c) => compileFilter(reg, c));
    return '(' + cs.join(n.comb === 'and' ? ' AND ' : ' OR ') + ')';
  }
  if (n.op === 'time_range') {
    const [s, e] = n.range;
    return winSql(s, e);
  }
  const inList = (vals) => vals.map(q1).join(', ');
  if (n.op === 'in') {
    const parts = [];
    if (n.dim === 'region') {
      const provs = n.values.filter((v) => reg.nodeIdx.region.get(v).level === 1);
      const cities = n.values.filter((v) => reg.nodeIdx.region.get(v).level === 2);
      if (provs.length) parts.push(`region_prov IN (${inList(provs)})`);
      if (cities.length) parts.push(`region_city IN (${inList(cities)})`);
    } else {
      const c1s = n.values.filter((v) => reg.nodeIdx.industry.get(v).level === 1);
      const c2s = n.values.filter((v) => reg.nodeIdx.industry.get(v).level === 2);
      if (c1s.length) parts.push(`ind_c1 IN (${inList(c1s)})`);
      if (c2s.length) parts.push(`ind_c2 IN (${inList(c2s)})`);
    }
    return parts.join(' OR ');
  }
  // descendantOf：path 前缀物化 → 冗余列等值（省→prov，市→city；门类→c1，大类→c2）
  const node = reg.nodeIdx[n.dim].get(n.value);
  if (n.dim === 'region') return node.level === 1 ? `region_prov = ${q1(node.code)}` : `region_city = ${q1(node.code)}`;
  return node.level === 1 ? `ind_c1 = ${q1(node.code)}` : `ind_c2 = ${q1(node.code)}`;
}

/* ================================ 6. 编译主入口 ================================ */

/** 指标编码 → 列别名（m1..mN，按规范化后 metrics 字典序） */
function aliasMapOf(rts) {
  const m = new Map();
  rts.forEach((rt, i) => m.set(rt.code.code, 'm' + (i + 1)));
  return m;
}

/**
 * 编译 Doris 方言 SQL（确定性：同输入 → 逐字节同输出）
 * @param {*} input { body, rts, family, reg, role, roleDef, watermark, cacheKey, helpers }
 *   - body/rts/family：index.js normalizeQuery 产物（已校验/排序/消解）
 *   - reg：注册表（nodeIdx/regionNodes/industryNodes，供过滤编译）
 *   - roleDef：roles.json 运行时角色（RLS 注入）
 *   - helpers：{ shiftMonth, metricWindow } 引擎窗口原语（防循环依赖，DI 注入）
 * @returns {{ sql: string, warnings: string[] }}
 */
function compileDorisSql(input) {
  const { body, rts, family, reg, role, roleDef, watermark, cacheKey, helpers } = input;
  if (!helpers || typeof helpers.shiftMonth !== 'function' || typeof helpers.metricWindow !== 'function') {
    throw new Error('compileDorisSql 需要 helpers:{shiftMonth,metricWindow}（引擎原语注入）');
  }
  const warnings = [];
  const [m0, m1] = body.time.range;
  const compares = body.time.compare.slice().sort(); // 规范化已排序；再排序防御（'mom'<'yoy'）
  const OFF = { mom: -1, yoy: -12 };

  /* ---- 各指标各窗口（主窗 + 各 compare 基窗），全部经引擎 metricWindow 解析（含 ratio ytd/末月口径） ---- */
  const metricWindows = rts.map((rt) => {
    const mw = { main: helpers.metricWindow(rt, m0, m1, 0), base: {} };
    for (const c of compares) mw.base[c] = helpers.metricWindow(rt, m0, m1, OFF[c]);
    return mw;
  });

  /* ---- 求值包络：WHERE period 范围 = 全部窗口（主窗+基窗）的 min/max（双窗口结构） ---- */
  let lo = null, hi = null;
  for (const mw of metricWindows) {
    for (const w of [mw.main].concat(compares.map((c) => mw.base[c]))) {
      if (lo === null || w[0] < lo) lo = w[0];
      if (hi === null || w[1] > hi) hi = w[1];
    }
  }

  /* ---- SELECT 投影 ---- */
  const specs = getRatioSqlSpecs(helpers.shiftMonth);
  const aliases = aliasMapOf(rts);
  const selectParts = [];
  const groupCols = [];
  const emit = (expr, alias, rt) => {
    // 脱敏在投影层（契约 §2）：非"一般"数据级指标 → mask() 函数包裹（Doris 侧 UDF 占位），登记 warning
    const dl = rt.code.data_level;
    if (dl && dl !== '一般') {
      warnings.push(`MASK_APPLIED:${rt.code.code}:data_level=${dl}→mask() 投影`);
      return `mask(${expr}) AS ${alias}`;
    }
    return `${expr} AS ${alias}`;
  };
  for (const d of body.dimensions) {
    const col = DORIS_GRAN_COL[d.dim + '|' + d.granularity];
    selectParts.push(`${col} AS dim_${d.dim}`);
    groupCols.push(col);
  }
  rts.forEach((rt, i) => {
    const n = i + 1;
    const mw = metricWindows[i];
    let valueExpr;
    if (rt.kind === 'ratio') {
      const spec = specs[rt.code.code];
      if (!spec) throw new Error('ratio 指标缺少 Doris 投影模板：' + rt.code.code);
      valueExpr = spec.expr(spec.fields.map((f) => caseSum(f.col, mw.main[0], mw.main[1])));
      selectParts.push(emit(valueExpr, 'm' + n, rt));
      for (const c of compares) {
        const fb = spec.expr(spec.fields.map((f) => caseSum(f.col, mw.base[c][0], mw.base[c][1])));
        selectParts.push(emit(fb, `m${n}_${c}_base`, rt));
      }
    } else {
      // sum（窗口直加）与 last（cumulative/snapshot，窗口已折叠到末月单月）同构
      valueExpr = caseSum(rt.field, mw.main[0], mw.main[1]);
      selectParts.push(emit(valueExpr, 'm' + n, rt));
      for (const c of compares) {
        selectParts.push(emit(caseSum(rt.field, mw.base[c][0], mw.base[c][1]), `m${n}_${c}_base`, rt));
      }
    }
  });

  /* ---- WHERE：行族门 + RLS 编译期注入 + 显式过滤 + 包络窗口 ---- */
  const where = [];
  where.push(family === 'ind' ? 'ind_c2 IS NOT NULL' : 'ind_c2 IS NULL');
  if (roleDef && roleDef.rls && roleDef.rls.type === 'path_prefix') {
    where.push(`region_prov = ${q1(roleDef.bind_node)}`);
  }
  for (const f of body.filters) where.push(compileFilter(reg, f));
  where.push(winSql(lo, hi));

  /* ---- ORDER BY：显式 sort 优先；缺省=维度列升序 + 首指标降序（契约 §2.2.5 同式） ---- */
  const orderBy = [];
  if (body.sort && body.sort.length) {
    for (const s of body.sort) {
      let col;
      if (s.by.startsWith('dim:')) {
        const dname = s.by.slice(4);
        const d = body.dimensions.find((x) => x.dim === dname);
        col = d ? DORIS_GRAN_COL[d.dim + '|' + d.granularity] : null;
      } else {
        col = aliases.get(s.by) || null;
      }
      if (col) orderBy.push(`${col} ${s.order === 'asc' ? 'ASC' : 'DESC'}`);
    }
  }
  if (!orderBy.length) {
    for (const g of groupCols) orderBy.push(`${g} ASC`);
    if (rts.length) orderBy.push(`${aliases.get(rts[0].code.code)} DESC`);
  }

  /* ---- LIMIT 兜底（契约 §2：2000 上限；body.limit 已由 Schema 限 1..1000，此处再兜底） ---- */
  const limit = Math.min(body.limit || 50, LIMIT_CAP);

  const header = `/* watermark=${watermark} cacheKey=${cacheKey} role=${role} */`;
  const sql = header +
    '\nSELECT ' + selectParts.join(', ') +
    '\nFROM ' + DORIS_TABLE +
    '\nWHERE ' + where.join('\n  AND ') +
    (groupCols.length ? '\nGROUP BY ' + groupCols.join(', ') : '') +
    (orderBy.length ? '\nORDER BY ' + orderBy.join(', ') : '') +
    '\nLIMIT ' + limit;
  return { sql, warnings };
}

/* ================================ 7. Doris FE REST 执行器 ================================ */

/**
 * NDJSON 流式解析：逐行 JSON.parse；空行跳过；容错尾换行/前导空白。
 * FE 返回（Accept: application/vnd.doris.query+json;v=1）每行一个 JSON 对象。
 */
function parseNdjson(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t));
  }
  return rows;
}

/**
 * Doris FE REST 查询：POST {fe}/api/query/{db}
 * Header：Authorization Basic / Accept: application/vnd.doris.query+json;v=1
 * Body：{ stmt: sql }；响应 NDJSON 流式解析（内存上限 32MB 防护）
 * @returns {Promise<Array<object>>} 行数组
 */
function executeOnDoris(opts) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(opts.fe.replace(/\/+$/, '') + '/api/query/' + encodeURIComponent(opts.db)); }
    catch (e) { return reject(Object.assign(new Error('DORIS_FE 非法：' + e.message), { dorisStatus: null })); }
    const bodyBuf = Buffer.from(JSON.stringify({ stmt: opts.sql }), 'utf8');
    const auth = Buffer.from(String(opts.user) + ':' + String(opts.pass), 'utf8').toString('base64');
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 8030, // FE 查询端口缺省 8030（MySQL 协议口为 9030，REST 为 http_port）
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + auth,
        Accept: 'application/vnd.doris.query+json;v=1',
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
      },
      timeout: opts.timeoutMs || 8000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 32 * 1024 * 1024) { req.destroy(); reject(new Error('Doris 响应超过 32MB 上限')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(Object.assign(new Error('Doris FE HTTP ' + res.statusCode), { dorisStatus: res.statusCode, dorisBody: text.slice(0, 500) }));
          return;
        }
        try { resolve(parseNdjson(text)); }
        catch (e) { reject(Object.assign(new Error('NDJSON 解析失败：' + e.message), { dorisStatus: res.statusCode })); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Doris FE 请求超时')));
    req.on('error', (e) => reject(e));
    req.end(bodyBuf);
  });
}

/**
 * Doris 侧失败 → 现有 10 错误码体系映射：统一归 500 INTERNAL
 * （后端基础设施故障不外泄为客户端 4xx；定位信息收进 detail，不透传 FE 原始文案）
 */
function dorisErrorDetail(err) {
  return {
    backend: 'doris',
    reason: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
    dorisStatus: err && err.dorisStatus != null ? err.dorisStatus : null,
  };
}

/* ================================ 8. FE 行 → 契约响应形状 ================================ */

const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10000) / 10000);

/**
 * FE NDJSON 行 → 契约响应 data 形状：
 *   维度列（dim_*）经维表解码（code/name/path）；指标别名 m{i}/m{i}_{cmp}_base →
 *   value/base/delta/rate 引擎同式现算（r2/r4；compare_then_compute 的 rate=null；
 *   基期或当期缺失 → 空同比子对象缺省，与引擎 compareObject 语义一致）
 */
function mapDorisRows(rows, ctx) {
  const { reg, rts, dimensions, compares, aliasMap } = ctx;
  return (rows || []).map((row) => {
    const dims = {};
    for (const d of dimensions) {
      const raw = row['dim_' + d.dim];
      if (d.dim === 'time') {
        dims.time = { code: raw, name: raw };
      } else {
        const node = reg.nodeIdx[d.dim] ? reg.nodeIdx[d.dim].get(raw) : null;
        dims[d.dim] = { code: raw, name: node ? node.name : raw, path: node ? node.path : undefined };
      }
    }
    const metricsOut = {};
    for (const rt of rts) {
      const a = aliasMap.get(rt.code.code);
      const entry = { value: r2(row[a]) };
      for (const c of compares) {
        const b = row[a + '_' + c + '_base'];
        if (b == null || entry.value == null) continue; // 基期/当期口径缺失 → 空同比（引擎同语义）
        const delta = r2(entry.value - b);
        entry[c] = rt.policy === 'compare_then_compute'
          ? { policy: rt.policy, base: r2(b), delta, rate: null }
          : { policy: rt.policy, base: r2(b), delta, rate: b === 0 ? null : r4(delta / Math.abs(b)) };
      }
      metricsOut[rt.code.code] = entry;
    }
    return { dims, metrics: metricsOut };
  });
}

/**
 * 引擎同式排序 + limit（契约 §2.2.5：显式 sort 优先；缺省=维度编码升序 + 首指标降序；null 排最后）
 * 返回 { data, rows, truncated, totalBeforeLimit }（与 index.js executeQuery 出口同构）
 */
function sortLimitData(data, body, rts) {
  const dimCode = (row, dim) => (row.dims[dim] ? row.dims[dim].code : '');
  data.sort((a, b) => {
    for (const d of body.dimensions) {
      const x = dimCode(a, d.dim), y = dimCode(b, d.dim);
      if (x !== y) return x < y ? -1 : 1;
    }
    const first = rts[0].code.code;
    return (b.metrics[first].value || -Infinity) - (a.metrics[first].value || -Infinity);
  });
  for (const s of body.sort || []) {
    const dir = s.order === 'asc' ? 1 : -1;
    data.sort((a, b) => {
      const k = (row) => (s.by.startsWith('dim:') ? dimCode(row, s.by.slice(4)) : row.metrics[s.by].value);
      const x = k(a), y = k(b);
      if (x === y) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  }
  const truncated = data.length > body.limit;
  const out = data.slice(0, body.limit);
  return { data: out, rows: out.length, truncated, totalBeforeLimit: data.length };
}

/**
 * shadow 双跑对账：按维度键对齐后逐指标比对 value/base（同舍入），返回差异清单（无差异 → null）。
 * 仅记录（audit/warning），绝不改动 local 主路径响应（黄金值保底）。
 */
function diffData(localData, dorisData, rts) {
  const keyOf = (row) => Object.keys(row.dims).map((d) => row.dims[d] && row.dims[d].code).join('\u0001');
  const dMap = new Map((dorisData || []).map((r) => [keyOf(r), r]));
  const diffs = [];
  for (const l of localData || []) {
    const d = dMap.get(keyOf(l));
    if (!d) { diffs.push({ key: keyOf(l), reason: 'row_missing_in_doris' }); continue; }
    for (const rt of rts) {
      const lm = l.metrics[rt.code.code], dm = d.metrics[rt.code.code];
      if (!dm) { diffs.push({ key: keyOf(l), metric: rt.code.code, reason: 'metric_missing_in_doris' }); continue; }
      if (JSON.stringify(lm.value) !== JSON.stringify(dm.value)) diffs.push({ key: keyOf(l), metric: rt.code.code, field: 'value', local: lm.value, doris: dm.value });
      for (const c of ['yoy', 'mom']) {
        const lb = lm[c] && lm[c].base, db2 = dm[c] && dm[c].base;
        if (JSON.stringify(lb) !== JSON.stringify(db2)) diffs.push({ key: keyOf(l), metric: rt.code.code, field: c + '.base', local: lb, doris: db2 });
      }
    }
  }
  return diffs.length ? diffs.slice(0, 5) : null;
}

/* ================================ 9. 导出 ================================ */

module.exports = {
  // Executor 抽象
  getExecutor,
  resolveExecutor,
  // 编译器
  compileDorisSql,
  aliasMapOf,
  getRatioSqlSpecs,
  DORIS_TABLE,
  LIMIT_CAP,
  DORIS_GRAN_COL,
  // 执行器
  executeOnDoris,
  parseNdjson,
  dorisErrorDetail,
  // 结果加工
  mapDorisRows,
  sortLimitData,
  diffData,
};

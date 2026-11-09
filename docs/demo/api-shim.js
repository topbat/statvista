'use strict';
/* ============================================================
 * 统计数据可视表平台 · 静态体验站 API Shim（零后端，GitHub Pages 可部署）
 * 依据：docs/mvp/03-DSL与API契约.md；引擎移植自 mvp/server/index.js（只读参考）
 *
 * 拦截 window.fetch：URL 含 '/api/v1/' 的请求全部本地应答：
 *   GET  /api/v1/meta/metrics          → ./data/metrics.json 契约变换（与后端 handleMetaMetrics 同构）
 *   GET  /api/v1/meta/dims             → ./data/dims.json 按 parent/depth 计算 roots/children（含 isLeaf；RLS 裁剪）
 *   GET  /api/v1/meta/dashboard/:id    → ./data/dashboards.json 对应项
 *   POST /api/v1/query                 → 浏览器端查询引擎（叶子事实聚合上卷/维度/过滤/同环比/排序/RLS 全语义）
 *   POST /api/v1/admin/watermark       → bump 版本因子（D11 演示）
 *
 * 事实数据：./data/facts-lite.json（列式精简版，4840 行 ≈360KB），首次拦截时 fetch 并缓存 Promise。
 * 引擎结构：顶部 /* node-testable *​/ const QE = {...}，挂 window.__STATVISTA_QE__；
 * 并 module.exports = QE 便于 Node 端对账测试（mvp/tools/test-demo-shim.node.js）。
 * ============================================================ */

/* node-testable */
const QE = (function () {

  /* ================================ 1. 常量与工具（移植 server/index.js §1） ================================ */

  const TIME_MIN = '2024-01';              // 契约 §2.1：time.range 合法域下界
  const TIME_MAX = '2026-10';              // 契约 §2.1：合法域上界
  const CACHE_TTL_MS = 300 * 1000;         // 契约 §2.7：TTL 兜底 300s
  const METRIC_PATTERN = /^(MACRO|TECH)\.[A-Z0-9_]+\.[A-Z0-9]{6,8}$/;
  const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

  // 逻辑维度粒度 → 事实表物理列（契约 §2.2.2 映射表 N1/N2/N3）
  const GRAN_COL = {
    'region|province': 'prov',
    'region|city': 'city',
    'industry|industry_c1': 'c1',
    'industry|industry_c2': 'c2',
    'time|time_month': 'month',
  };
  const GRAN_CAP = {
    'region|province': 'prov',
    'region|city': 'city',
    'industry|industry_c1': 'c1',
    'industry|industry_c2': 'c2',
    'time|time_month': 'month',
  };
  const GRAN_OK = {
    region: ['province', 'city'],
    industry: ['industry_c1', 'industry_c2'],
    time: ['time_month'],
  };

  /** 月份平移：shiftMonth('2026-01', -1) → '2025-12'（YYYY-MM 字典序即时间序） */
  function shiftMonth(ym, k) {
    const y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
    const t = y * 12 + m + k;
    const ny = Math.floor(t / 12), nm = (t % 12) + 1;
    return ny + '-' + String(nm).padStart(2, '0');
  }

  const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
  const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10000) / 10000);

  /** 稳定序列化：对象键递归排序（canonicalDSL 用，契约 §2.7 规则 3） */
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  /** FNV-1a 32 位（shim 端 cacheKey 用；与后端 sha256 非同值，对账不比对 cacheKey） */
  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /** 业务错误：status + code + message + detail（契约 §2.4；普通对象，跨环境可序列化） */
  function apiError(status, code, message, detail) {
    return { isApiError: true, status, code, message, detail: detail || {} };
  }
  function schemaInvalid(pointer, reason) {
    return apiError(400, 'DSL_SCHEMA_INVALID', '请求体不符合 QueryRequest Schema：' + reason, { pointer, reason });
  }

  /* ================================ 2. 数据加载与索引（移植 §2 buildRegistry） ================================ */

  const state = {
    reg: null,                 // buildRegistry 产物
    dashboards: [],            // 看板配置清单（dashboards.json）
    dashIdx: new Map(),
    watermark: 'demo',         // 静态体验站固定水位标识
    metricDefVersion: 'md-3',
    dimTreeVersion: 'dt-1',
    cache: new Map(),
    traceSeq: 0,
    loadPromise: null,
  };

  function buildRegistry(metricsDoc, dimsDoc, rolesDoc, factsRows) {
    // ---- 维度索引：code → node（region/industry 各自建）；同时保留出现顺序 ----
    const regionNodes = dimsDoc.region.nodes;
    const industryNodes = dimsDoc.industry.nodes;
    const nodeIdx = { region: new Map(), industry: new Map() };
    for (const n of regionNodes) nodeIdx.region.set(n.code, n);
    for (const n of industryNodes) nodeIdx.industry.set(n.code, n);

    const DATA_MIN = dimsDoc.time.from;   // 事实数据实际下界（2025-01）
    const DATA_MAX = dimsDoc.time.to;

    // ---- 原子字段族：atomic_store.grain 含 c2 → 行业行（fact_ind），否则区域行（fact_region）----
    const fieldFamily = new Map();
    for (const a of metricsDoc.atomic_store) fieldFamily.set(a.field, a.grain.includes('c2') ? 'ind' : 'region');

    // ---- 指标编码 → 支撑原子字段（含 @py 基值列）----
    const codeField = new Map();
    for (const a of metricsDoc.atomic_store) codeField.set(a.code, a.field);

    // ---- 指标运行时注册表 ----
    const M = new Map();
    for (const def of metricsDoc.metrics) {
      let fields;
      if (def.store && def.store.field) fields = [def.store.field];
      else if (def.store && def.store.fields) fields = def.store.fields.slice();
      else {
        const f = def.formula || {};
        fields = [];
        for (const key of ['num', 'den']) {
          if (!f[key]) continue;
          const bare = f[key].replace(/@py$/, '');
          const fld = codeField.get(f[key]) || codeField.get(bare);
          if (fld) fields.push(fld);
        }
      }
      const families = [...new Set(fields.map((f) => fieldFamily.get(f)).filter(Boolean))];
      let policy = def.compare_policy;
      if (def.agg_type === 'sum' && def.compare_policy === 'window_sum') policy = 'direct';
      else if (def.agg_type === 'cumulative') policy = 'cumulative';
      else if (def.agg_type === 'snapshot') policy = 'snapshot';

      M.set(def.code, {
        code: def,
        fields,
        family: families.length === 1 ? families[0] : 'ind',
        kind: def.agg_type === 'sum' ? 'sum' : (def.agg_type === 'ratio' ? 'ratio' : 'last'),
        field: def.store && def.store.field ? def.store.field : null,
        policy,
        allowedCompares: def.compare_ops.slice(),
      });
    }

    const ROLES = new Map(rolesDoc.roles.map((r) => [r.id, r]));
    const facts = factsRows;
    return { metricsDoc, dimsDoc, rolesDoc, regionNodes, industryNodes, nodeIdx, DATA_MIN, DATA_MAX, M, ROLES, facts };
  }

  /* ============================ 3. 指标求值（移植 §3，含 RATIO_SPECS） ============================ */

  /** 窗口内字段求和；窗口内无该口径字段任何行 → null */
  function sumField(rows, field, s, e) {
    let t = 0, n = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.month >= s && r.month <= e) {
        const v = r.vals[field];
        if (v != null) { t += v; n++; }
      }
    }
    return n > 0 ? t : null;
  }

  /** ratio 型指标专用求值器（compare_then_compute 的执行依据，D3） */
  const RATIO_SPECS = {
    'MACRO.GDP.GR0001': {
      win: (m0, m1, o) => { const e = shiftMonth(m1, o); return [e.slice(0, 4) + '-01', e]; },
      calc: (rows, s, e) => {
        const a = sumField(rows, 'gdp_va', s, e), b = sumField(rows, 'gdp_va_py', s, e);
        return (a == null || b == null || b === 0) ? null : r2((a / b - 1) * 100);
      },
      sqlCols: [["gdp_va", "num"], ["gdp_va_py", "den"]],
    },
    'MACRO.CPI.IDX0003': {
      win: (m0, m1, o) => [shiftMonth(m0, o), shiftMonth(m1, o)],
      calc: (rows, s, e) => {
        const a = sumField(rows, 'cpi_lvl', s, e), b = sumField(rows, 'cpi_lvl_py', s, e);
        return (a == null || b == null || b === 0) ? null : r2((a / b - 1) * 100);
      },
      sqlCols: [["cpi_lvl", "num"], ["cpi_lvl_py", "den"]],
    },
    'MACRO.ENGI.GR0009': {
      win: (m0, m1, o) => [shiftMonth(m0, o), shiftMonth(m1, o)],
      calc: (rows, s, e) => {
        const n = sumField(rows, 'eng_con', s, e), d = sumField(rows, 'gdp_va', s, e);
        const np = sumField(rows, 'eng_con_py', s, e), dp = sumField(rows, 'gdp_va_py', s, e);
        if (n == null || d == null || np == null || dp == null || d === 0 || dp === 0) return null;
        return r2((1 - (n / d) / (np / dp)) * 100);
      },
      sqlCols: [["eng_con", "num"], ["gdp_va", "den"], ["eng_con_py", "num_py"], ["gdp_va_py", "den_py"]],
    },
    'TECH.RD.INT0002': {
      win: (m0, m1, o) => { const e = shiftMonth(m1, o); return [e.slice(0, 4) + '-01', e]; },
      calc: (rows, s, e) => {
        const n = sumField(rows, 'rd_cu', e, e), d = sumField(rows, 'gdp_va', s, e);
        return (n == null || d == null || d === 0) ? null : r2((n / d) * 100);
      },
      sqlCols: [["rd_cu", "num"], ["gdp_va", "den"]],
    },
    'TECH.PAT.SH0004': {
      win: (m0, m1, o) => [shiftMonth(m0, o), shiftMonth(m1, o)],
      calc: (rows, s, e) => {
        const n = sumField(rows, 'pat_inv', s, e), d = sumField(rows, 'pat_va', s, e);
        return (n == null || d == null || d === 0) ? null : r2((n / d) * 100);
      },
      sqlCols: [["pat_inv", "num"], ["pat_va", "den"]],
    },
  };

  /** 指标在参考窗 [m0,m1] 与偏移 off 下的实际聚合窗 */
  function metricWindow(rt, m0, m1, off) {
    if (rt.kind === 'sum') return [shiftMonth(m0, off), shiftMonth(m1, off)];
    if (rt.kind === 'last') { const e = shiftMonth(m1, off); return [e, e]; }
    return RATIO_SPECS[rt.code.code].win(m0, m1, off);
  }

  /** 指标求值（当期值） */
  function evalMetric(rt, rows, s, e) {
    if (rt.kind === 'ratio') return RATIO_SPECS[rt.code.code].calc(rows, s, e);
    const v = sumField(rows, rt.field, s, e);
    return v == null ? null : r2(v);
  }

  /** 同环比值对象（契约 §2.5）；基期窗口不在事实数据窗内 → undefined */
  function compareObject(rt, rows, m0, m1, kind, value) {
    const off = kind === 'yoy' ? -12 : -1;
    const [ws, we] = metricWindow(rt, m0, m1, off);
    if (ws < state.reg.DATA_MIN) return undefined;
    const base = evalMetric(rt, rows, ws, we);
    if (base == null || value == null) return undefined;
    const delta = r2(value - base);
    if (rt.policy === 'compare_then_compute') return { policy: rt.policy, base, delta, rate: null };
    const rate = base === 0 ? null : r4(delta / Math.abs(base));
    return { policy: rt.policy, base, delta, rate };
  }

  /* ============================ 4. DSL 校验与规范化（移植 §4 normalizeQuery） ============================ */

  const TOP_KEYS = new Set(['metrics', 'dimensions', 'filters', 'time', 'sort', 'limit']);
  const LEAF_KEYS = new Set(['dim', 'op', 'values', 'value', 'range', 'sourceChartId']);
  const KNOWN_ROLES = new Set(['leader', 'prov-js', 'prov-gd']);

  /** 过滤节点结构校验（递归）：返回规范化节点（剥离未知字段；保留 sourceChartId 用于回显） */
  function validateFilterNode(node, pointer, ctx) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw schemaInvalid(pointer, '过滤节点必须是对象');
    }
    for (const k of Object.keys(node)) if (!LEAF_KEYS.has(k)) ctx.stripped.push(pointer + '/' + k);

    if (node.comb !== undefined) {
      if (node.comb === 'and' || node.comb === 'or') {
        if (!Array.isArray(node.children) || node.children.length < (node.comb === 'or' ? 2 : 1)) {
          throw schemaInvalid(pointer, node.comb + ' 节点 children 数组长度非法');
        }
        return { comb: node.comb, children: node.children.map((c, i) => validateFilterNode(c, pointer + '/children/' + i, ctx)) };
      }
      if (node.comb === 'not') {
        if (node.child === undefined) throw schemaInvalid(pointer, 'not 节点缺少 child');
        return { comb: 'not', child: validateFilterNode(node.child, pointer + '/child', ctx) };
      }
      throw schemaInvalid(pointer, 'comb 取值非法：' + String(node.comb));
    }

    const dim = node.dim, op = node.op;
    if (!['region', 'industry', 'time'].includes(dim)) throw schemaInvalid(pointer, '叶子 dim 非法');
    if (!['in', 'descendantOf', 'time_range'].includes(op)) throw schemaInvalid(pointer, '叶子 op 非法');
    if (dim === 'time' && op !== 'time_range') throw schemaInvalid(pointer, 'dim=time 仅允许 op=time_range');
    if (op === 'in' && (!Array.isArray(node.values) || node.values.length < 1 || node.values.length > 50 || !node.values.every((v) => typeof v === 'string'))) {
      throw schemaInvalid(pointer, 'op=in 必填 values（1..50 个字符串）');
    }
    if (op === 'descendantOf' && typeof node.value !== 'string') throw schemaInvalid(pointer, 'op=descendantOf 必填 value');
    if (op === 'time_range' && (!Array.isArray(node.range) || node.range.length !== 2 || !node.range.every((v) => MONTH_PATTERN.test(v)))) {
      throw schemaInvalid(pointer, 'op=time_range 必填 range（[起月,止月]）');
    }
    const leaf = { dim, op };
    if (op === 'in') leaf.values = node.values.slice();
    if (op === 'descendantOf') leaf.value = node.value;
    if (op === 'time_range') leaf.range = node.range.slice();
    if (typeof node.sourceChartId === 'string') leaf.sourceChartId = node.sourceChartId;
    return leaf;
  }

  /** 值类叶子（in/descendantOf 的 region/industry 过滤）参与 last-wins 消解 */
  const isValueLeaf = (n) => !n.comb && (n.op === 'in' || n.op === 'descendantOf') && n.dim !== 'time';

  /** 剥离叶子中的 sourceChartId（缓存无感，契约 §2.2.4-3） */
  function stripEcho(n) {
    if (n.comb === 'not') return { comb: 'not', child: stripEcho(n.child) };
    if (n.comb) return { comb: n.comb, children: n.children.map(stripEcho) };
    const c = Object.assign({}, n);
    delete c.sourceChartId;
    return c;
  }

  /**
   * 规范化 + 校验 + 消解（契约 §2.2.4 / §2.7）
   * 返回 { body, canonical, appliedFilters, stripped, rts, family }；失败抛 apiError 对象
   */
  function normalizeQuery(raw) {
    const reg = state.reg;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw schemaInvalid('', '请求体必须是 JSON 对象');
    }
    const ctx = { stripped: [] };
    for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) ctx.stripped.push('/' + k);

    // ---- metrics ----
    if (!Array.isArray(raw.metrics) || raw.metrics.length < 1 || raw.metrics.length > 8) {
      throw schemaInvalid('/metrics', 'metrics 必填，1..8 个编码');
    }
    for (let i = 0; i < raw.metrics.length; i++) {
      const c = raw.metrics[i];
      if (typeof c !== 'string' || !METRIC_PATTERN.test(c)) {
        throw schemaInvalid('/metrics/' + i, '指标编码非法（禁止裸 SQL）：' + JSON.stringify(c));
      }
      if (!reg.M.has(c)) {
        throw apiError(404, 'METRIC_NOT_FOUND', '指标编码未注册：' + c, { metric: c, registeredCount: reg.M.size });
      }
    }
    const metrics = [...new Set(raw.metrics)].sort();

    // ---- dimensions ----
    const dims = raw.dimensions === undefined ? [] : raw.dimensions;
    if (!Array.isArray(dims) || dims.length > 3) throw schemaInvalid('/dimensions', 'dimensions 最多 3 个');
    const seenDim = new Set();
    const dimensions = dims.map((d, i) => {
      if (typeof d !== 'object' || d === null) throw schemaInvalid('/dimensions/' + i, '维度声明必须是对象');
      if (d.dim === undefined || d.granularity === undefined) throw schemaInvalid('/dimensions/' + i, '缺 dim 或 granularity');
      if (!GRAN_OK[d.dim] || !GRAN_OK[d.dim].includes(d.granularity)) {
        throw schemaInvalid('/dimensions/' + i, `维度 ${d.dim} 不支持粒度 ${d.granularity}`);
      }
      if (seenDim.has(d.dim)) throw schemaInvalid('/dimensions/' + i, `维度 ${d.dim} 重复声明（同维度只允许一个粒度）`);
      seenDim.add(d.dim);
      return { dim: d.dim, granularity: d.granularity };
    });

    // ---- filters（结构校验 + 值校验 + last-wins 消解）----
    const filtersRaw = raw.filters === undefined ? [] : raw.filters;
    if (!Array.isArray(filtersRaw)) throw schemaInvalid('/filters', 'filters 必须是数组');
    let filters = filtersRaw.map((f, i) => validateFilterNode(f, '/filters/' + i, ctx));

    // ---- time ----
    const t = raw.time;
    if (typeof t !== 'object' || t === null) throw schemaInvalid('/time', 'time 必填');
    if (t.grain !== 'month') throw schemaInvalid('/time/grain', 'grain 仅支持 month');
    if (!Array.isArray(t.range) || t.range.length !== 2 || !t.range.every((v) => typeof v === 'string' && MONTH_PATTERN.test(v))) {
      throw apiError(400, 'INVALID_TIME_RANGE', 'time.range 须为 [起月,止月]，YYYY-MM 格式', { range: t.range, allowed: [TIME_MIN, TIME_MAX] });
    }
    const [m0, m1] = t.range;
    if (m0 > m1) throw apiError(400, 'INVALID_TIME_RANGE', 'time.range 起 > 止', { range: t.range, allowed: [TIME_MIN, TIME_MAX] });
    if (m0 < TIME_MIN || m1 > TIME_MAX) {
      throw apiError(400, 'INVALID_TIME_RANGE', `time.range 越界（合法域 ${TIME_MIN} ~ ${TIME_MAX}）`, { range: t.range, allowed: [TIME_MIN, TIME_MAX] });
    }
    let compare = t.compare === undefined ? [] : t.compare;
    if (!Array.isArray(compare) || !compare.every((c) => c === 'yoy' || c === 'mom')) throw schemaInvalid('/time/compare', 'compare 仅允许 yoy/mom');
    if (new Set(compare).size !== compare.length) throw schemaInvalid('/time/compare', 'compare 不允许重复');
    compare = compare.slice().sort();

    // ---- sort ----
    let sort = raw.sort === undefined ? [] : raw.sort;
    if (!Array.isArray(sort)) throw schemaInvalid('/sort', 'sort 必须是数组');
    sort = sort.map((s, i) => {
      if (typeof s !== 'object' || s === null || typeof s.by !== 'string') throw schemaInvalid('/sort/' + i, 'sort.by 必填');
      const order = s.order === undefined ? 'desc' : s.order;
      if (order !== 'asc' && order !== 'desc') throw schemaInvalid('/sort/' + i, 'sort.order 仅 asc/desc');
      if (s.by.startsWith('dim:')) {
        const d = s.by.slice(4);
        if (!['region', 'industry', 'time'].includes(d)) throw schemaInvalid('/sort/' + i, 'sort.by 维度名非法');
        if (!seenDim.has(d)) throw schemaInvalid('/sort/' + i, `sort.by=dim:${d} 但未声明该维度`);
      } else if (!metrics.includes(s.by)) {
        throw schemaInvalid('/sort/' + i, 'sort.by 指标编码未在 metrics 中声明');
      }
      return { by: s.by, order };
    });

    // ---- limit ----
    let limit = raw.limit === undefined ? 50 : raw.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw schemaInvalid('/limit', 'limit 须为 1..1000 整数');

    /* ---- 过滤叶子值校验（维表存在性 → BAD_FILTER；time 子区间 → INVALID_TIME_RANGE）---- */
    const checkLeaf = (leaf, pointer) => {
      if (leaf.op === 'in') {
        for (const v of leaf.values) {
          if (!reg.nodeIdx[leaf.dim].has(v)) {
            throw apiError(400, 'BAD_FILTER', `过滤值不在${leaf.dim}维表中：` + v, { filter: leaf, reason: 'value_not_in_dim_table' });
          }
        }
      } else if (leaf.op === 'descendantOf') {
        if (!reg.nodeIdx[leaf.dim].has(leaf.value)) {
          throw apiError(400, 'BAD_FILTER', `descendantOf 节点不在${leaf.dim}维表中：` + leaf.value, { filter: leaf, reason: 'value_not_in_dim_table' });
        }
      } else if (leaf.op === 'time_range') {
        const [fs, fe] = leaf.range;
        if (fs > fe) throw apiError(400, 'INVALID_TIME_RANGE', 'filters.time_range 起 > 止', { range: leaf.range, allowed: [TIME_MIN, TIME_MAX] });
        if (fs < m0 || fe > m1) {
          throw apiError(400, 'INVALID_TIME_RANGE', 'filters.time_range 必须是 time.range 的子区间', { range: leaf.range, allowed: [m0, m1] });
        }
      }
    };
    const walkCheck = (n, p) => {
      if (n.comb === 'not') walkCheck(n.child, p + '/child');
      else if (n.comb) n.children.forEach((c, i) => walkCheck(c, p + '/children/' + i));
      else checkLeaf(n, p);
    };
    filters.forEach((f, i) => walkCheck(f, '/filters/' + i));

    /* ---- 同 dim 值叶子 last-wins 消解（纯 AND 上下文，契约 §2.2.4-1）---- */
    const andLeaves = [];
    const collectLeaves = (nodes) => {
      for (const n of nodes) {
        if (n.comb === 'and') collectLeaves(n.children);
        else if (!n.comb) andLeaves.push(n);
      }
    };
    collectLeaves(filters);
    const lastOf = new Map();
    for (const leaf of andLeaves) if (isValueLeaf(leaf)) lastOf.set(leaf.dim, leaf);
    const stripSuperseded = (n) => {
      if (n.comb === 'not') return { comb: 'not', child: stripSuperseded(n.child) };
      if (n.comb) {
        const ch = n.children.map(stripSuperseded).filter(Boolean);
        if (ch.length === 0) return null;
        return { comb: n.comb, children: ch };
      }
      if (isValueLeaf(n) && lastOf.get(n.dim) !== n) return null;
      return n;
    };
    filters = filters.map(stripSuperseded).filter(Boolean);

    const appliedFilters = andLeaves.map((leaf) => {
      const echo = { dim: leaf.dim, op: leaf.op };
      if (leaf.op === 'in') echo.values = leaf.values.slice();
      if (leaf.op === 'descendantOf') echo.value = leaf.value;
      if (leaf.op === 'time_range') echo.range = leaf.range.slice();
      if (leaf.sourceChartId !== undefined) echo.sourceChartId = leaf.sourceChartId;
      echo.status = (!isValueLeaf(leaf) || lastOf.get(leaf.dim) === leaf) ? 'active' : 'superseded';
      return echo;
    });

    /* ---- 指标兼容性：单事实表（行族）+ 维度能力（契约 §2.2.1 DIM_MISMATCH）---- */
    const rts = metrics.map((c) => reg.M.get(c));
    const fam = rts[0].family;
    const bad = rts.filter((r) => r.family !== fam).map((r) => r.code.code);
    if (bad.length) {
      throw apiError(400, 'DIM_MISMATCH', '多指标不属于同一事实表（行族冲突）', { metrics: [rts[0].code.code, bad[0]], dimension: null });
    }
    const capCheck = (dim, capKey, pointer) => {
      for (const rt of rts) {
        const caps = rt.code.dim_caps[dim] || [];
        if (!caps.includes(capKey)) {
          throw apiError(400, 'DIM_MISMATCH', `指标 ${rt.code.code} 不支持 ${dim}:${capKey} 维度`, { metrics: [rt.code.code], dimension: `${dim}:${capKey}` });
        }
      }
    };
    for (const d of dimensions) capCheck(d.dim, GRAN_CAP[d.dim + '|' + d.granularity]);
    const capLeaf = (n) => {
      if (n.comb === 'not') { capLeaf(n.child); return; }
      if (n.comb) { n.children.forEach(capLeaf); return; }
      if (n.dim === 'time') return;
      const codes = n.op === 'in' ? n.values : [n.value];
      for (const c of codes) capCheck(n.dim, reg.nodeIdx[n.dim].get(c).level === 1 ? (n.dim === 'region' ? 'prov' : 'c1') : (n.dim === 'region' ? 'city' : 'c2'));
    };
    filters.forEach(capLeaf);

    /* ---- compare 策略裁决（契约 §2.5 / 403 COMPARE_POLICY_FORBIDDEN）---- */
    for (const kind of compare) {
      for (const rt of rts) {
        if (!rt.allowedCompares.includes(kind)) {
          throw apiError(403, 'COMPARE_POLICY_FORBIDDEN',
            rt.policy === 'cumulative' ? '累计型指标禁用环比，仅接受同比' : `${rt.code.name}（${rt.policy}）不允许 ${kind} 比较`,
            { metric: rt.code.code, policy: rt.policy, requested: kind });
        }
      }
    }

    /* ---- canonicalDSL（缓存键原料，契约 §2.7 规则 1-5）---- */
    const canonicalFilters = filters
      .map((n) => JSON.parse(stableStringify(stripEcho(n))))
      .sort((a, b) => (stableStringify(a) < stableStringify(b) ? -1 : 1));
    const canonical = stableStringify({
      metrics,
      dimensions,
      filters: canonicalFilters,
      time: { grain: 'month', range: [m0, m1], compare },
      sort: sort.length ? sort : '__default__',
      limit,
    });

    return {
      body: { metrics, dimensions, filters, time: { grain: 'month', range: [m0, m1], compare }, sort, limit },
      canonical, appliedFilters, stripped: ctx.stripped, rts, family: fam,
    };
  }

  /* ============================ 5. 过滤编译（移植 §5 compileLeaf/compileNode） ============================ */

  /** 叶子 → 行级谓词（等价编译：descendantOf 物化 path 前缀 ⇒ 冗余列等值/IN 过滤，零 JOIN） */
  function compileLeaf(reg, leaf) {
    if (leaf.op === 'time_range') {
      const [s, e] = leaf.range;
      return { test: (r) => r.month >= s && r.month <= e, sql: `month BETWEEN '${s}' AND '${e}'` };
    }
    if (leaf.op === 'in') {
      if (leaf.dim === 'region') {
        const provs = new Set(leaf.values.filter((v) => reg.nodeIdx.region.get(v).level === 1));
        const cities = new Set(leaf.values.filter((v) => reg.nodeIdx.region.get(v).level === 2));
        const parts = [];
        if (provs.size) parts.push(`region_prov IN (${[...provs].map((v) => `'${v}'`).join(',')})`);
        if (cities.size) parts.push(`region_city IN (${[...cities].map((v) => `'${v}'`).join(',')})`);
        return { test: (r) => provs.has(r.prov) || cities.has(r.city), sql: parts.join(' OR ') };
      }
      const c1s = new Set(leaf.values.filter((v) => reg.nodeIdx.industry.get(v).level === 1));
      const c2s = new Set(leaf.values.filter((v) => reg.nodeIdx.industry.get(v).level === 2));
      const parts = [];
      if (c1s.size) parts.push(`ind_c1 IN (${[...c1s].map((v) => `'${v}'`).join(',')})`);
      if (c2s.size) parts.push(`ind_c2 IN (${[...c2s].map((v) => `'${v}'`).join(',')})`);
      return { test: (r) => c1s.has(r.c1) || c2s.has(r.c2), sql: parts.join(' OR ') };
    }
    const node = reg.nodeIdx[leaf.dim].get(leaf.value);
    if (leaf.dim === 'region') {
      if (node.level === 1) return { test: (r) => r.prov === node.code, sql: `region_prov = '${node.code}'` };
      return { test: (r) => r.city === node.code, sql: `region_city = '${node.code}'` };
    }
    if (node.level === 1) return { test: (r) => r.c1 === node.code, sql: `ind_c1 = '${node.code}'` };
    return { test: (r) => r.c2 === node.code, sql: `ind_c2 = '${node.code}'` };
  }

  function compileNode(reg, n) {
    if (n.comb === 'not') {
      const c = compileNode(reg, n.child);
      return { test: (r) => !c.test(r), sql: `NOT (${c.sql})` };
    }
    if (n.comb) {
      const cs = n.children.map((c) => compileNode(reg, c));
      const join = n.comb === 'and' ? ' AND ' : ' OR ';
      return { test: (r) => cs[n.comb === 'and' ? 'every' : 'some']((c) => c.test(r)), sql: '(' + cs.map((c) => c.sql).join(join) + ')' };
    }
    return compileLeaf(reg, n);
  }

  /* ============================ 6. 查询执行（移植 §6 executeQuery） ============================ */

  /**
   * 执行规范化查询（RLS 已注入谓词）
   * 步骤：RLS ∩ 显式过滤 → 行集；主时间窗确定分组键值域；组桶内按指标窗口聚合 + 同环比
   */
  function executeQuery(role, norm) {
    const reg = state.reg;
    const { body, rts } = norm;
    const [m0, m1] = body.time.range;
    const compare = body.time.compare;

    // ---- RLS 编译期注入（契约 §2.6.2）：绑定节点 path 前缀过滤，等价编译为冗余列等值 ----
    const roleDef = reg.ROLES.get(role);
    let rlsPred = null;
    if (roleDef.rls.type === 'path_prefix') {
      const root = reg.nodeIdx.region.get(roleDef.bind_node);
      rlsPred = { test: (r) => r.prov === root.code, sql: `region_prov = '${root.code}'` };
    }

    // ---- 行级谓词合成：最终 WHERE = RLS ∩ 显式过滤 ----
    const filterPreds = body.filters.map((f) => compileNode(reg, f));
    const allPred = (r) => {
      if (rlsPred && !rlsPred.test(r)) return false;
      for (const p of filterPreds) if (!p.test(r)) return false;
      return true;
    };

    // ---- 行族选择 + 行集过滤（行业行进 fact_ind，区域行进 fact_region）----
    const rowsAll = reg.facts.filter((r) => norm.family === 'ind' ? r.c2 != null : r.c2 == null).filter(allPred);

    // ---- 分组 ----
    const groupCols = body.dimensions.map((d) => ({ dim: d.dim, col: GRAN_COL[d.dim + '|' + d.granularity] }));
    const timeIdx = groupCols.findIndex((g) => g.dim === 'time');
    const nonTimeIdx = groupCols.map((g, i) => i).filter((i) => i !== timeIdx);
    const buckets = new Map();
    const parentBuckets = new Map();
    const keyed = new Set();
    for (const r of rowsAll) {
      const kv = groupCols.map((g) => r[g.col]);
      const k = kv.join('\u0001');
      if (!buckets.has(k)) buckets.set(k, { kv, rows: [] });
      buckets.get(k).rows.push(r);
      const pk = nonTimeIdx.map((i) => kv[i]).join('\u0001');
      if (!parentBuckets.has(pk)) parentBuckets.set(pk, []);
      parentBuckets.get(pk).push(r);
      if (r.month >= m0 && r.month <= m1) keyed.add(k);
    }

    // ---- 组内指标求值（当期 + 请求的比较）----
    const data = [];
    for (const k of keyed) {
      const { kv, rows } = buckets.get(k);
      const dims = {};
      groupCols.forEach((g, i) => {
        const v = kv[i];
        if (g.dim === 'time') dims.time = { code: v, name: v };
        else {
          const node = reg.nodeIdx[g.dim].get(v);
          dims[g.dim] = { code: v, name: node ? node.name : v, path: node ? node.path : undefined };
        }
      });
      const metricsOut = {};
      const anchored = timeIdx >= 0 && kv[timeIdx] != null;
      const calcRows = anchored ? (parentBuckets.get(nonTimeIdx.map((i) => kv[i]).join('\u0001')) || rows) : rows;
      const w0 = anchored ? kv[timeIdx] : m0;
      const w1 = anchored ? kv[timeIdx] : m1;
      for (const rt of rts) {
        const [s, e] = metricWindow(rt, w0, w1, 0);
        const value = evalMetric(rt, calcRows, s, e);
        const entry = { value };
        if (compare.includes('yoy')) {
          const o = compareObject(rt, calcRows, w0, w1, 'yoy', value);
          if (o !== undefined) entry.yoy = o;
        }
        if (compare.includes('mom')) {
          const o = compareObject(rt, calcRows, w0, w1, 'mom', value);
          if (o !== undefined) entry.mom = o;
        }
        metricsOut[rt.code.code] = entry;
      }
      data.push({ dims, metrics: metricsOut });
    }

    // ---- 排序：声明 sort 优先；缺省=维度编码升序 + 首指标降序（契约 §2.2.5）----
    const dimOf = (row, dim) => row.dims[dim] ? row.dims[dim].code : '';
    data.sort((a, b) => {
      for (const g of groupCols) {
        const x = dimOf(a, g.dim), y = dimOf(b, g.dim);
        if (x !== y) return x < y ? -1 : 1;
      }
      const first = rts[0].code.code;
      return (b.metrics[first].value || -Infinity) - (a.metrics[first].value || -Infinity);
    });
    const sortKey = (row, by) => by.startsWith('dim:') ? dimOf(row, by.slice(4)) : row.metrics[by].value;
    for (const s of body.sort) {
      const dir = s.order === 'asc' ? 1 : -1;
      data.sort((a, b) => {
        const x = sortKey(a, s.by), y = sortKey(b, s.by);
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

  /* ============================ 7. SQL 展示产物（移植 §7 buildSql） ============================ */

  const SQL_COL = { prov: 'region_prov', city: 'region_city', c1: 'ind_c1', c2: 'ind_c2', month: 'month' };

  function buildSql(role, norm) {
    const reg = state.reg;
    const { body, rts } = norm;
    const [m0, m1] = body.time.range;
    const table = norm.family === 'ind' ? 'fact_ind' : 'fact_region';

    const selectParts = body.dimensions.map((d) => `${SQL_COL[GRAN_COL[d.dim + '|' + d.granularity]]} AS dim_${d.dim}`);
    rts.forEach((rt, i) => {
      const n = i + 1;
      if (rt.kind === 'ratio') {
        for (const [field, alias] of RATIO_SPECS[rt.code.code].sqlCols) selectParts.push(`SUM(${field}) AS ${alias}${n}`);
      } else if (rt.kind === 'last') {
        selectParts.push(`SUM(${rt.field}) AS m${n} /* 窗口末月累计/快照口径 */`);
      } else {
        selectParts.push(`SUM(${rt.field}) AS m${n}`);
      }
    });

    const where = [];
    const roleDef = reg.ROLES.get(role);
    if (roleDef.rls.type === 'path_prefix') where.push(`region_prov = '${roleDef.bind_node}'`);
    for (const f of body.filters) where.push(compileNode(reg, f).sql);
    where.push(m0 === m1 ? `month = '${m0}'` : `month BETWEEN '${m0}' AND '${m1}'`);

    return `SELECT ${selectParts.join(', ')} FROM ${table} WHERE ${where.join(' AND ')}` +
      (body.dimensions.length ? ` GROUP BY ${body.dimensions.map((d) => SQL_COL[GRAN_COL[d.dim + '|' + d.granularity]]).join(', ')}` : '');
  }

  /* ============================ 8. meta 端点实现（移植 §9 handleMetaMetrics/handleMetaDims/handleDashboard） ============================ */

  /** RLS 裁剪说明（契约 §2.6.3） */
  function rlsApplied(role) {
    const reg = state.reg;
    const d = reg.ROLES.get(role);
    if (!d || d.rls.type !== 'path_prefix') return null;
    return { dim: 'region', predicate: `path LIKE '${d.bind_node_path}%'`, scopePath: d.bind_node_path, visibleRoot: d.bind_node };
  }

  function metaMetrics(q) {
    const reg = state.reg;
    const g = (k) => (q && typeof q.get === 'function' ? q.get(k) : (q ? q[k] : null));
    const rows = [];
    for (const def of reg.metricsDoc.metrics) {
      const rt = reg.M.get(def.code);
      const item = {
        code: def.code,
        name: def.name,
        domain: def.theme,
        unit: def.unit,
        aggType: def.agg_type,
        comparePolicy: rt.policy,
        polarity: def.polarity === 'negative' ? 'inverse' : def.polarity,
        formula: def.formula && def.formula.expr ? def.formula.expr : null,
        numeratorRef: def.formula && def.formula.num ? def.formula.num : null,
        denominatorRef: def.formula && def.formula.den ? def.formula.den : null,
        ownerDept: def.owner,
        basisDocNo: def.basis,
        updateFreq: def.freq === '月度' ? 'monthly' : def.freq,
        dataClass: def.data_level === '一般' ? 'general' : def.data_level,
        windowMonths: def.windowMonths || null,
        allowedCompares: rt.allowedCompares,
      };
      if (g('domain') && item.domain !== g('domain')) continue;
      if (g('agg_type') && item.aggType !== g('agg_type')) continue;
      if (g('polarity') && item.polarity !== g('polarity')) continue;
      const cp = g('compare_policy');
      if (cp && item.comparePolicy !== cp && def.compare_policy !== cp) continue;
      const kw = g('q');
      if (kw && !(item.name.includes(kw) || item.code.includes(kw) || item.ownerDept.includes(kw))) continue;
      rows.push(item);
    }
    return { status: 200, body: { data: rows, meta: { count: reg.metricsDoc.metrics.length, metricDefVersion: state.metricDefVersion, filtered: rows.length } } };
  }

  function metaDims(dim, q, role) {
    const reg = state.reg;
    const gp = (k) => (q && typeof q.get === 'function' ? q.get(k) : (q ? q[k] : null));
    if (dim !== 'region' && dim !== 'industry') {
      throw schemaInvalid('/dim', 'dim 仅支持 region|industry');
    }
    const rawDepth = gp('depth');
    const depth = rawDepth === null || rawDepth === undefined ? 1 : parseInt(rawDepth, 10);
    if (![1, 2].includes(depth)) throw schemaInvalid('/depth', 'depth 仅支持 1|2');

    const roleDef = reg.ROLES.get(role);
    const scope = roleDef.rls.type === 'path_prefix' && dim === 'region' ? roleDef.bind_node_path : null;

    let parentCode = gp('parent');
    if (dim === 'region') {
      if (parentCode === 'ROOT' || parentCode === null || parentCode === undefined) parentCode = scope ? roleDef.bind_node : '000000';
      if (scope && parentCode !== roleDef.bind_node && parentCode !== '000000') {
        const node = reg.nodeIdx.region.get(parentCode);
        if (!node) throw schemaInvalid('/parent', 'parent 不在维表：' + parentCode);
        if (!node.path.startsWith(scope)) {
          return { status: 200, body: { data: [], meta: { dim, parent: parentCode, count: 0, dimTreeVersion: state.dimTreeVersion, rlsApplied: rlsApplied(role) } } };
        }
      }
    } else if (parentCode === null || parentCode === undefined || parentCode === 'ROOT') {
      parentCode = null;
    }
    if (parentCode != null && !reg.nodeIdx[dim].has(parentCode)) {
      throw schemaInvalid('/parent', 'parent 不在维表：' + parentCode);
    }

    const all = dim === 'region' ? reg.regionNodes : reg.industryNodes;
    const byParent = new Map();
    for (const n of all) {
      if (!byParent.has(n.parent)) byParent.set(n.parent, []);
      byParent.get(n.parent).push(n);
    }
    const out = [];
    let frontier = (byParent.get(parentCode) || []).filter((n) => !scope || n.path.startsWith(scope) || n.path === scope);
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      for (const n of frontier) {
        out.push({ code: n.code, name: n.name, parentCode: n.parent, path: n.path, level: n.level, isLeaf: n.level === 2 });
        for (const c of byParent.get(n.code) || []) if (!scope || c.path.startsWith(scope)) next.push(c);
      }
      frontier = next;
    }
    return { status: 200, body: { data: out, meta: { dim, parent: parentCode, count: out.length, dimTreeVersion: state.dimTreeVersion, rlsApplied: rlsApplied(role) } } };
  }

  function dashboard(id) {
    const d = state.dashIdx.get(id);
    if (!d) throw apiError(404, 'DASHBOARD_NOT_FOUND', '看板不存在：' + id, { dashboardId: id, known: [...state.dashIdx.keys()] });
    const etag = 'cfg-' + fnv1a(stableStringify(d)).slice(0, 4);
    return { status: 200, body: { data: d, meta: { version: d.version, etag, dimTreeVersion: state.dimTreeVersion, metricDefVersion: state.metricDefVersion } } };
  }

  /** bump 版本因子 → 换键即失效（D11 演示；静态体验站 cacheHit 演示同后端 miss→hit） */
  function bump(factor) {
    if (!['watermark', 'metricDef', 'dimTree'].includes(factor)) {
      throw schemaInvalid('/factor', 'factor 仅支持 watermark|metricDef|dimTree');
    }
    if (factor === 'metricDef') {
      const n = parseInt(state.metricDefVersion.split('-')[1], 10) + 1;
      state.metricDefVersion = 'md-' + n;
    } else if (factor === 'dimTree') {
      const n = parseInt(state.dimTreeVersion.split('-')[1], 10) + 1;
      state.dimTreeVersion = 'dt-' + n;
    } else {
      const seq = (parseInt((state.watermark.split('-')[2] || '1'), 10) || 1) + 1;
      state.watermark = `demo-${String(seq).padStart(2, '0')}`;
    }
    const cleared = state.cache.size;
    state.cache.clear();
    return { status: 200, body: { data: { factor, watermark: state.watermark, metricDefVersion: state.metricDefVersion, dimTreeVersion: state.dimTreeVersion, cleared }, meta: {} } };
  }

  /* ============================ 9. 查询主流程（移植 handleQuery；cacheKey 用 FNV 非 sha256） ============================ */

  function nextTraceId() {
    return 't-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-d' + String(++state.traceSeq).padStart(4, '0');
  }

  function errResponse(err, traceId) {
    const e = err && err.isApiError ? err : apiError(500, 'INTERNAL', '服务端内部错误', {});
    return { status: e.status, body: { error: { code: e.code, message: e.message, detail: e.detail, traceId } } };
  }

  /** 拦截层统一错误归一（meta/dashboard/bump 端点用；query 端点已内部捕获） */
  function err(errLike) {
    return errResponse(errLike, 't-demo-' + String(++state.traceSeq).padStart(4, '0'));
  }

  function query(raw, role) {
    const t0 = Date.now();
    const traceId = nextTraceId();
    try {
      const reg = state.reg;
      if (!reg) throw apiError(500, 'NOT_READY', '引擎未初始化', {});
      if (!role || !KNOWN_ROLES.has(role)) {
        throw apiError(401, 'UNAUTHENTICATED', 'X-Role 缺失或非法（leader|prov-js|prov-gd）', { received: role || null });
      }
      // ① 校验 + 规范化 + 消解
      const norm = normalizeQuery(raw);
      // ② 缓存（同后端：role 桶 + canonicalDSL + 版本因子；TTL 300s 兜底）
      const keyFull = fnv1a(['v1', role, norm.canonical, state.watermark, state.metricDefVersion, state.dimTreeVersion].join('|')) +
        '|' + fnv1a(norm.canonical + role);
      const cached = state.cache.get(keyFull);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        const resp = { data: cached.resp.data, meta: Object.assign({}, cached.resp.meta, { cacheHit: true, elapsedMs: Date.now() - t0 }) };
        return { status: 200, body: resp };
      }
      // ③ 执行（RLS 注入 + 聚合 + 同环比）
      const result = executeQuery(role, norm);
      const sql = buildSql(role, norm);
      const resp = {
        data: result.data,
        meta: {
          cacheHit: false,
          cacheKey: keyFull.slice(0, 8),
          watermark: state.watermark,
          metricDefVersion: state.metricDefVersion,
          dimTreeVersion: state.dimTreeVersion,
          elapsedMs: Date.now() - t0,
          rlsRole: role,
          rlsApplied: rlsApplied(role),
          appliedFilters: norm.appliedFilters,
          sql,
          rows: result.rows,
          truncated: result.truncated,
        },
      };
      state.cache.set(keyFull, { at: Date.now(), resp });
      return { status: 200, body: resp };
    } catch (err) {
      return errResponse(err, traceId);
    }
  }

  /* ============================ 10. 初始化与 facts-lite 解码 ============================ */

  /** facts-lite 列式行 → 服务端事实行 {prov,city,c1,c2,month,vals}（c1 由 dims industry 树 c2→parent 派生） */
  function decodeFacts(factsLite, dimsDoc) {
    const c2p = {};
    for (const n of dimsDoc.industry.nodes) if (n.level === 2) c2p[n.code] = n.parent;
    const D = factsLite.dims;
    const prov = D.prov, city = D.city, c2s = D.c2, mon = D.month;
    const FI = factsLite.fields.ind, FR = factsLite.fields.reg;
    const rows = [];
    for (const r of factsLite.rows) {
      if (r.length === 5) {          // 行业行：[pi,ci,c2i,mi,vals[]]
        const vals = {};
        for (let i = 0; i < FI.length; i++) if (r[4][i] != null) vals[FI[i]] = r[4][i];
        rows.push({ prov: prov[r[0]], city: city[r[1]], c1: c2p[c2s[r[2]]] || null, c2: c2s[r[2]], month: mon[r[3]], vals });
      } else {                        // 区域行：[pi,ci,mi,vals[]]
        const vals = {};
        for (let i = 0; i < FR.length; i++) if (r[3][i] != null) vals[FR[i]] = r[3][i];
        rows.push({ prov: prov[r[0]], city: city[r[1]], c1: null, c2: null, month: mon[r[2]], vals });
      }
    }
    return rows;
  }

  /**
   * 注入数据并构建注册表（Node 对账测试直接调用；浏览器端由 ensureLoaded 调）
   * data = { metricsDoc, dimsDoc, rolesDoc, factsLite | factsRows, dashboardsDoc? }
   */
  function init(data) {
    const factsRows = data.factsRows || decodeFacts(data.factsLite, data.dimsDoc);
    state.reg = buildRegistry(data.metricsDoc, data.dimsDoc, data.rolesDoc, factsRows);
    const dash = data.dashboardsDoc || [];
    const list = Array.isArray(dash) ? dash : (dash.dashboards || []);
    state.dashboards = list;
    state.dashIdx = new Map(list.map((d) => [d.dashboardId, d]));
    return { metrics: state.reg.M.size, facts: factsRows.length, dashboards: list.length };
  }

  return {
    init,
    query,
    metaMetrics,
    metaDims,
    dashboard,
    bump,
    err,
    normalizeQuery,   // 对账/调试用
    rlsApplied,
    _state: state,    // 测试窥视口
  };
})();

/* ---- 浏览器双出口：window 全局 + Node module.exports（node-testable） ---- */
if (typeof window !== 'undefined') window.__STATVISTA_QE__ = QE;
if (typeof module !== 'undefined' && module.exports) module.exports = QE;

/* ============================================================
 * 浏览器 fetch 拦截层：URL 含 '/api/v1/' 的请求全部本地应答
 * （Node 端对账测试不进入本段：window 无 fetch 即跳过）
 * ============================================================ */
(function installShim() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function' || typeof document === 'undefined') return;
  const origFetch = window.fetch.bind(window);

  /** 首次拦截时同步发起数据加载并缓存 Promise（失败允许重试） */
  let loadPromise = null;
  function loadJson(url) {
    return origFetch(url).then((r) => {
      if (!r.ok) throw new Error('加载失败：' + url + '（HTTP ' + r.status + '）');
      return r.text();
    }).then((t) => JSON.parse(t));
  }
  function ensureLoaded() {
    if (QE._state.reg) return Promise.resolve();
    if (!loadPromise) {
      loadPromise = Promise.all([
        loadJson('./data/metrics.json'),
        loadJson('./data/dims.json'),
        loadJson('./data/roles.json'),
        loadJson('./data/dashboards.json'),
        loadJson('./data/facts-lite.json'),
      ]).then((res) => {
        QE.init({
          metricsDoc: res[0], dimsDoc: res[1], rolesDoc: res[2],
          dashboardsDoc: res[3], factsLite: res[4],
        });
      });
      loadPromise.catch(() => { loadPromise = null; });
    }
    return loadPromise;
  }

  function toResponse(result) {
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Demo-Shim': 'statvista-local' },
    });
  }

  function getRole(init) {
    const h = init && init.headers;
    if (!h) return null;
    if (typeof h.get === 'function') return h.get('X-Role');
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'x-role') return h[k];
    return null;
  }

  async function readBody(init) {
    let b = init && init.body;
    if (b == null) return null;
    if (typeof b === 'string') return JSON.parse(b || 'null');
    if (typeof b.text === 'function') return JSON.parse(await b.text() || 'null');
    return null;
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (url.indexOf('/api/v1/') === -1) return origFetch(input, init);

    return ensureLoaded().then(() => {
      let p, searchParams, role, result;
      try {
        // 以解析后的 href 定位 '/api/v1/' 标记取子路径（兼容根绝对路径 / 站点子路径 / 任意 origin）
        const u = new URL(url, window.location && window.location.href || 'http://localhost/');
        const marker = '/api/v1/';
        const i = u.href.indexOf(marker);
        if (i < 0) throw { isApiError: true, status: 404, code: 'NOT_FOUND', message: 'API 路由不存在：' + url, detail: { path: url } };
        const rest = u.href.slice(i + marker.length).split('#')[0];
        const qi = rest.indexOf('?');
        p = qi < 0 ? rest : rest.slice(0, qi);
        searchParams = new URLSearchParams(qi < 0 ? '' : rest.slice(qi + 1));
        role = getRole(init);

        if (p === 'query' && method === 'POST') {
          return readBody(init).then((raw) => toResponse(QE.query(raw, role)));
        }
        if (p === 'admin/watermark' && method === 'POST') {
          return readBody(init).then((raw) => {
            const factor = raw && typeof raw.factor === 'string' ? raw.factor : 'watermark';
            try { return toResponse(QE.bump(factor)); }
            catch (e) { return toResponse(QE.err(e)); }
          });
        }
        if (p === 'meta/metrics' && method === 'GET') {
          result = QE.metaMetrics(searchParams);
        } else if (p === 'meta/dims' && method === 'GET') {
          result = QE.metaDims(searchParams.get('dim'), searchParams, role);
        } else {
          const m = p.match(/^meta\/dashboard\/([A-Za-z0-9_-]+)$/);
          if (m && method === 'GET') result = QE.dashboard(m[1]);
          else {
            result = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'API 路由不存在：/api/v1' + p, detail: { path: p }, traceId: 't-demo-' + String(++QE._state.traceSeq).padStart(4, '0') } } };
          }
        }
        return toResponse(result);
      } catch (e) {
        return toResponse(QE.err(e));
      }
    }).catch((e) => {
      // 数据加载失败等致命错误：503 + 明确错误码（app.js 侧展示中文错误）
      return new Response(JSON.stringify({ error: { code: 'DEMO_DATA_UNAVAILABLE', message: '体验站数据加载失败（' + ((e && e.message) || e) + '）', detail: {}, traceId: 't-demo-0000' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
  };
})();

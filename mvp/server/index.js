'use strict';
/**
 * ============================================================================
 * T05 · 统计数据可视表平台 MVP —— 语义层服务（零依赖 Node，仅内置模块）
 * 契约依据：docs/mvp/03-DSL与API契约.md（唯一取数契约，字段命名以该文档为准）
 * 数据依据：mvp/data/{metrics,dims,facts,roles}.json（T02 种子冻结版）
 *
 * 端点总览：
 *   POST /api/v1/query              查询主端点（DSL 校验→RLS 注入→内存聚合→同环比→缓存）
 *   POST /api/v1/admin/watermark    bump 数据水位/版本（watermark|metricDef|dimTree），缓存即时失效
 *   GET  /api/v1/meta/metrics       指标字典（元数据驱动渲染源，D16）
 *   GET  /api/v1/meta/dims          维度树（RLS 裁剪，D8）
 *   GET  /api/v1/meta/dashboard/:id 看板配置（看板即 JSON；缺 dashboards.json 时用内置默认，待 T07 替换）
 *   GET  / + /assets/*              静态服务 ../web（charset=utf-8）
 *
 * 设计要点（与契约条款一一对应）：
 *   - 事实表只存原子值：sum 直接加和；ratio 只聚合分子分母再算比值（D3）；
 *     cumulative/snapshot 时间不可加，折叠到窗口末月；省/全国值全部由市×大类叶子行上卷派生。
 *   - RLS 谓词编译期注入（X-Role → 绑定节点 path 前缀），请求体任何授权类字段在规范化阶段剥离（D9）。
 *   - 行级越权 → 200 空集，不报错不泄露（D7）；过滤消解（纯 AND 上下文同 dim 值叶子 last-wins，D15）。
 *   - 缓存键 = sha256("v1"|role|canonicalDSL|watermark|metricDefVersion|dimTreeVersion)，TTL 300s 兜底。
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ================================ 1. 常量与工具 ================================ */

const TIME_MIN = '2024-01';              // 契约 §2.1：time.range 合法域下界
const TIME_MAX = '2026-10';              // 契约 §2.1：合法域上界
const CACHE_TTL_MS = 300 * 1000;         // 契约 §2.7：TTL 兜底 300s
// 契约 §2.1 示意为 [A-Z0-9]{6}，但 PRD §2.2 冻结编码含 7 位后缀（MACRO.CPI.IDX0003 / TECH.RD.INT0002）——
// 以冻结编码为准放宽至 {6,8}（仍禁止空格/引号/分号等注入字符，未注册编码另有 404 兜底，D2 不受影响）
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
// 粒度 → metrics.dim_caps 中的能力键
const GRAN_CAP = {
  'region|province': 'prov',
  'region|city': 'city',
  'industry|industry_c1': 'c1',
  'industry|industry_c2': 'c2',
  'time|time_month': 'month',
};
// 合法 dim×granularity 组合（契约 dimensionDecl allOf）
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

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** 业务错误：status + code + message + detail（契约 §2.4） */
class ApiError extends Error {
  constructor(status, code, message, detail = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/* ================================ 2. 数据加载与索引 ================================ */

const DATA_DIR = path.join(__dirname, '..', 'data');
const WEB_ROOT = path.join(__dirname, '..', 'web');

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function buildRegistry(dataDir) {
  const metricsDoc = loadJson(path.join(dataDir, 'metrics.json'));
  const dimsDoc = loadJson(path.join(dataDir, 'dims.json'));
  const rolesDoc = loadJson(path.join(dataDir, 'roles.json'));
  const factsDoc = loadJson(path.join(dataDir, 'facts.json'));

  // ---- 维度索引：code → node（region/industry 各自建）；同时保留出现顺序 ----
  const regionNodes = dimsDoc.region.nodes;
  const industryNodes = dimsDoc.industry.nodes;
  const nodeIdx = { region: new Map(), industry: new Map() };
  for (const n of regionNodes) nodeIdx.region.set(n.code, n);
  for (const n of industryNodes) nodeIdx.industry.set(n.code, n);

  const DATA_MIN = dimsDoc.time.from;   // 事实数据实际下界（2025-01）：比较基期可用性判断
  const DATA_MAX = dimsDoc.time.to;

  // ---- 原子字段族：atomic_store.grain 含 c2 → 行业行（fact_ind），否则区域行（fact_region）----
  const fieldFamily = new Map();        // field -> 'ind' | 'region'
  for (const a of metricsDoc.atomic_store) fieldFamily.set(a.field, a.grain.includes('c2') ? 'ind' : 'region');

  // ---- 指标编码 → 支撑原子字段（含 @py 基值列）----
  const codeField = new Map();          // 'MACRO.GDP.VA0001' -> 'gdp_va'，'...@py' -> 'gdp_va_py'
  for (const a of metricsDoc.atomic_store) codeField.set(a.code, a.field);

  // ---- 指标运行时注册表 ----
  const M = new Map(); // code -> 运行时指标定义
  for (const def of metricsDoc.metrics) {
    // 依赖字段：优先 store.field / store.fields；ratio 型由 formula.num/den 递归解析（含 @py）
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
    // 契约级比较策略（§2.5）：种子字典 window_sum/none 映射为 direct/cumulative/snapshot
    let policy = def.compare_policy;
    if (def.agg_type === 'sum' && def.compare_policy === 'window_sum') policy = 'direct';
    else if (def.agg_type === 'cumulative') policy = 'cumulative';
    else if (def.agg_type === 'snapshot') policy = 'snapshot';

    M.set(def.code, {
      code: def,                        // 原始字典定义
      fields,
      family: families.length === 1 ? families[0] : 'ind', // 混族不该出现；防御取 ind
      kind: def.agg_type === 'sum' ? 'sum' : (def.agg_type === 'ratio' ? 'ratio' : 'last'), // last = cumulative/snapshot
      field: def.store && def.store.field ? def.store.field : null,
      policy,                           // 契约策略：direct|compare_then_compute|cumulative|snapshot|window_sum|none
      allowedCompares: def.compare_ops.slice(), // metrics.json compare_ops 已按策略冻结
    });
  }

  // ---- 角色索引 ----
  const ROLES = new Map(rolesDoc.roles.map((r) => [r.id, r]));

  // ---- 事实行（唯一事实表；行业行 c1/c2 非空，区域行 c1/c2 为 null）----
  const facts = factsDoc.rows;

  return { metricsDoc, dimsDoc, rolesDoc, factsDoc, regionNodes, industryNodes, nodeIdx, DATA_MIN, DATA_MAX, M, ROLES, facts };
}

/* ============================ 3. 指标求值（内存聚合 + 同环比） ============================ */

/** 窗口内字段求和；窗口内无该口径字段任何行 → null（"字段缺失即口径不适用"） */
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

/**
 * ratio 型指标的专用求值器（compare_then_compute 的执行依据，D3）
 * 每项声明：win(m0,m1,offset)→实际聚合窗 [s,e]；calc(rows,s,e)→比值
 * 窗口语义：offset=0 当期；-12 同比基期；-1 环比基期（ytd 型随年末月平移）
 */
const RATIO_SPECS = {
  // GDP 累计同比增速：(ytd(gdp_va)/ytd(gdp_va_py) - 1) × 100 —— 分母为上年同期累计（行内 py 基值列）
  'MACRO.GDP.GR0001': {
    win: (m0, m1, o) => { const e = shiftMonth(m1, o); return [e.slice(0, 4) + '-01', e]; },
    calc: (rows, s, e) => {
      const a = sumField(rows, 'gdp_va', s, e), b = sumField(rows, 'gdp_va_py', s, e);
      return (a == null || b == null || b === 0) ? null : r2((a / b - 1) * 100);
    },
    sqlCols: [["gdp_va", "num"], ["gdp_va_py", "den"]],
  },
  // CPI 当月同比：(Σcpi_lvl / Σcpi_lvl_py - 1) × 100（上级区域 Σ分子/Σ分母 等权合成）
  'MACRO.CPI.IDX0003': {
    win: (m0, m1, o) => [shiftMonth(m0, o), shiftMonth(m1, o)],
    calc: (rows, s, e) => {
      const a = sumField(rows, 'cpi_lvl', s, e), b = sumField(rows, 'cpi_lvl_py', s, e);
      return (a == null || b == null || b === 0) ? null : r2((a / b - 1) * 100);
    },
    sqlCols: [["cpi_lvl", "num"], ["cpi_lvl_py", "den"]],
  },
  // 单位GDP能耗降低率：(1 - (Σeng_con/Σgdp_va)/(Σeng_con_py/Σgdp_va_py)) × 100（逆指标，D5）
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
  // R&D 投入强度：分子=末月 R&D 累计（入库即累计），分母=本年 1 月至末月累计 GDP；× 100
  'TECH.RD.INT0002': {
    win: (m0, m1, o) => { const e = shiftMonth(m1, o); return [e.slice(0, 4) + '-01', e]; },
    calc: (rows, s, e) => {
      const n = sumField(rows, 'rd_cu', e, e), d = sumField(rows, 'gdp_va', s, e);
      return (n == null || d == null || d === 0) ? null : r2((n / d) * 100);
    },
    sqlCols: [["rd_cu", "num"], ["gdp_va", "den"]],
  },
  // 发明专利授权占比：Σpat_inv / Σpat_va × 100
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
  if (rt.kind === 'last') { const e = shiftMonth(m1, off); return [e, e]; } // cumulative/snapshot：折叠到末月
  return RATIO_SPECS[rt.code.code].win(m0, m1, off);
}

/** 指标求值（当期值） */
function evalMetric(rt, rows, s, e) {
  if (rt.kind === 'ratio') return RATIO_SPECS[rt.code.code].calc(rows, s, e);
  const v = sumField(rows, rt.field, s, e); // sum 与 last 统一为窗口内 Σ（last 窗口即末月单月）
  return v == null ? null : r2(v);
}

/**
 * 同环比值对象（契约 §2.5）：基期窗口不在事实数据窗内 → 返回 undefined（子对象缺省=空同比）
 * direct/cumulative/snapshot：base=基期聚合值，delta=value-base，rate=delta/|base|
 * compare_then_compute：base=基期窗口按同公式重算的比值，delta=两比值之差（pct 点），rate=null
 */
function compareObject(rt, rows, m0, m1, kind, value) {
  const off = kind === 'yoy' ? -12 : -1;
  const [ws, we] = metricWindow(rt, m0, m1, off);
  if (ws < DATA_MIN_REF) return undefined;           // 基期不在事实窗（2025-01 前）→ 空同比
  const base = evalMetric(rt, rows, ws, we);
  if (base == null || value == null) return undefined; // 基期或当期口径缺失
  const delta = r2(value - base);
  if (rt.policy === 'compare_then_compute') return { policy: rt.policy, base, delta, rate: null };
  const rate = base === 0 ? null : r4(delta / Math.abs(base));
  return { policy: rt.policy, base, delta, rate };
}

let DATA_MIN_REF = '2025-01'; // buildRegistry 后覆盖（模块级引用，供 compareObject 使用）

/* ============================ 4. DSL 校验与规范化 ============================ */

const TOP_KEYS = new Set(['metrics', 'dimensions', 'filters', 'time', 'sort', 'limit']);
const LEAF_KEYS = new Set(['dim', 'op', 'values', 'value', 'range', 'sourceChartId']);
const KNOWN_ROLES = new Set(['leader', 'prov-js', 'prov-gd']);

function schemaInvalid(pointer, reason) {
  return new ApiError(400, 'DSL_SCHEMA_INVALID', '请求体不符合 QueryRequest Schema：' + reason, { pointer, reason });
}

/**
 * 过滤节点结构校验（递归）：返回规范化节点（剥离未知字段；保留 sourceChartId 用于回显）
 * 数组语义 AND；and/or/not 递归；叶子按 op 校验必填值
 */
function validateFilterNode(node, pointer, ctx) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw schemaInvalid(pointer, '过滤节点必须是对象');
  }
  // 剥离未知字段（D9：不报错、记审计）
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

  // ---- 叶子 ----
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
  if (typeof node.sourceChartId === 'string') leaf.sourceChartId = node.sourceChartId; // 仅溯源回显，不入缓存键
  return leaf;
}

/** 值类叶子（in/descendantOf 的 region/industry 过滤）参与 last-wins 消解 */
const isValueLeaf = (n) => !n.comb && (n.op === 'in' || n.op === 'descendantOf') && n.dim !== 'time';

/**
 * 规范化 + 校验 + 消解（契约 §2.2.4 / §2.7）
 * 返回 { body(规范化后请求), canonical(缓存键用), appliedFilters, stripped }
 */
function normalizeQuery(raw, reg) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw schemaInvalid('', '请求体必须是 JSON 对象');
  }
  const ctx = { stripped: [] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) ctx.stripped.push('/' + k); // D9：伪造授权参数剥离

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
      throw new ApiError(404, 'METRIC_NOT_FOUND', '指标编码未注册：' + c, { metric: c, registeredCount: reg.M.size });
    }
  }
  const metrics = [...new Set(raw.metrics)].sort(); // 去重 + 字典序（契约 §2.7 规则 5）

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
    throw new ApiError(400, 'INVALID_TIME_RANGE', 'time.range 须为 [起月,止月]，YYYY-MM 格式', { range: t.range, allowed: [TIME_MIN, TIME_MAX] });
  }
  const [m0, m1] = t.range;
  if (m0 > m1) throw new ApiError(400, 'INVALID_TIME_RANGE', 'time.range 起 > 止', { range: t.range, allowed: [TIME_MIN, TIME_MAX] });
  if (m0 < TIME_MIN || m1 > TIME_MAX) {
    throw new ApiError(400, 'INVALID_TIME_RANGE', `time.range 越界（合法域 ${TIME_MIN} ~ ${TIME_MAX}）`, { range: t.range, allowed: [TIME_MIN, TIME_MAX] });
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
          throw new ApiError(400, 'BAD_FILTER', `过滤值不在${leaf.dim}维表中：` + v, { filter: leaf, reason: 'value_not_in_dim_table' });
        }
      }
    } else if (leaf.op === 'descendantOf') {
      if (!reg.nodeIdx[leaf.dim].has(leaf.value)) {
        throw new ApiError(400, 'BAD_FILTER', `descendantOf 节点不在${leaf.dim}维表中：` + leaf.value, { filter: leaf, reason: 'value_not_in_dim_table' });
      }
    } else if (leaf.op === 'time_range') {
      const [fs, fe] = leaf.range;
      if (fs > fe) throw new ApiError(400, 'INVALID_TIME_RANGE', 'filters.time_range 起 > 止', { range: leaf.range, allowed: [TIME_MIN, TIME_MAX] });
      if (fs < m0 || fe > m1) {
        throw new ApiError(400, 'INVALID_TIME_RANGE', 'filters.time_range 必须是 time.range 的子区间', { range: leaf.range, allowed: [m0, m1] });
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
  const andLeaves = []; // 按出现顺序（深度优先）
  const collectLeaves = (nodes) => {
    for (const n of nodes) {
      if (n.comb === 'and') collectLeaves(n.children);
      else if (!n.comb) andLeaves.push(n);
      // or/not 分支内的叶子不参与消解（语义不同，全部保留）
    }
  };
  collectLeaves(filters);
  const lastOf = new Map(); // dim -> 最后一个值类叶子
  for (const leaf of andLeaves) if (isValueLeaf(leaf)) lastOf.set(leaf.dim, leaf);
  // 从树中剥离 superseded 叶子（不参与谓词与缓存键）
  const stripSuperseded = (n) => {
    if (n.comb === 'not') return { comb: 'not', child: stripSuperseded(n.child) };
    if (n.comb) {
      const ch = n.children.map(stripSuperseded).filter(Boolean);
      if (ch.length === 0) return null;
      return { comb: n.comb, children: ch };
    }
    if (isValueLeaf(n) && lastOf.get(n.dim) !== n) return null; // superseded → 剥离
    return n;
  };
  filters = filters.map(stripSuperseded).filter(Boolean);

  // appliedFilters 回显（AND 上下文叶子，active/superseded，含 sourceChartId；契约 §2.2.4-2）
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
    throw new ApiError(400, 'DIM_MISMATCH', '多指标不属于同一事实表（行族冲突）', { metrics: [rts[0].code.code, bad[0]], dimension: null });
  }
  const capCheck = (dim, capKey, pointer) => {
    for (const rt of rts) {
      const caps = rt.code.dim_caps[dim] || [];
      if (!caps.includes(capKey)) {
        throw new ApiError(400, 'DIM_MISMATCH', `指标 ${rt.code.code} 不支持 ${dim}:${capKey} 维度`, { metrics: [rt.code.code], dimension: `${dim}:${capKey}` });
      }
    }
  };
  for (const d of dimensions) capCheck(d.dim, GRAN_CAP[d.dim + '|' + d.granularity]);
  const capLeaf = (n) => {
    if (n.comb === 'not') { capLeaf(n.child); return; }
    if (n.comb) { n.children.forEach(capLeaf); return; }
    if (n.dim === 'time') return;
    // 过滤值层级 → 能力键（省→prov，市→city，门类→c1，大类→c2）
    const codes = n.op === 'in' ? n.values : [n.value];
    for (const c of codes) capCheck(n.dim, reg.nodeIdx[n.dim].get(c).level === 1 ? (n.dim === 'region' ? 'prov' : 'c1') : (n.dim === 'region' ? 'city' : 'c2'));
  };
  filters.forEach(capLeaf);

  /* ---- compare 策略裁决（契约 §2.5 / 403 COMPARE_POLICY_FORBIDDEN）---- */
  for (const kind of compare) {
    for (const rt of rts) {
      if (!rt.allowedCompares.includes(kind)) {
        throw new ApiError(403, 'COMPARE_POLICY_FORBIDDEN',
          rt.policy === 'cumulative' ? '累计型指标禁用环比，仅接受同比' : `${rt.code.name}（${rt.policy}）不允许 ${kind} 比较`,
          { metric: rt.code.code, policy: rt.policy, requested: kind });
      }
    }
  }

  /* ---- canonicalDSL（缓存键原料，契约 §2.7 规则 1-5）---- */
  const canonicalFilters = filters
    .map((n) => JSON.parse(stableStringify(stripEcho(n)))) // 深拷贝并剥 sourceChartId
    .sort((a, b) => (stableStringify(a) < stableStringify(b) ? -1 : 1)); // 消解后排序（规则 3）
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

/** 剥离叶子中的 sourceChartId（缓存无感，契约 §2.2.4-3） */
function stripEcho(n) {
  if (n.comb === 'not') return { comb: 'not', child: stripEcho(n.child) };
  if (n.comb) return { comb: n.comb, children: n.children.map(stripEcho) };
  const c = Object.assign({}, n);
  delete c.sourceChartId;
  return c;
}

/* ============================ 5. 过滤编译（谓词 + SQL 片段） ============================ */

/** 维度节点子树编码集（descendantOf：path 前缀语义，含自身） */
function subtreeCodes(reg, dim, code) {
  const node = reg.nodeIdx[dim].get(code);
  const out = [];
  for (const n of dim === 'region' ? reg.regionNodes : reg.industryNodes) {
    if (n.path === node.path || n.path.startsWith(node.path)) out.push(n.code);
  }
  return out;
}

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
  // descendantOf：解析物化 path 后按节点层级等值编译（省→prov，市→city；门类→c1，大类→c2）
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

/* ============================ 6. 查询执行（聚合引擎） ============================ */

/**
 * 执行规范化查询（RLS 已注入谓词）
 * 步骤：RLS ∩ 显式过滤 → 行集；主时间窗确定分组键值域；组桶内按指标窗口聚合 + 同环比
 */
function executeQuery(state, role, norm) {
  const { reg } = state;
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
  const timeIdx = groupCols.findIndex((g) => g.dim === 'time');       // 声明 time 维度 → 窗口按桶月锚定
  const nonTimeIdx = groupCols.map((g, i) => i).filter((i) => i !== timeIdx);
  const buckets = new Map();  // key → {keyVals:[...], rows:[]}
  const parentBuckets = new Map(); // 非时间维度键 → 全月行集（月桶窗口聚合取数用）
  const keyed = new Set();     // 主时间窗内出现过的组键（确定组存在性）
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
    /* 声明 time 维度时：指标窗口锚定到桶月 bm（[bm,bm]），行集改取同组非时间维度的全月行——
       ratio(ytd)/cumulative 按该月为止的累计口径、sum 的同环比基期为单月（D6 与下钻正交）；
       未声明 time 维度（指标卡单行/地区分组）维持全局窗口 [m0,m1] 语义不变 */
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
        if (o !== undefined) entry.yoy = o;   // 基期缺数据 → 子对象缺省（空同比）
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
      if (x == null) return 1;   // null 值排最后
      if (y == null) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  }

  const truncated = data.length > body.limit;
  const out = data.slice(0, body.limit);
  return { data: out, rows: out.length, truncated, totalBeforeLimit: data.length };
}

/* ============================ 7. SQL 展示产物（meta.sql，D1：无 JOIN） ============================ */

/* 种子行字段名 → 契约物理列名（§2.2.2/N4）：meta.sql 出口统一映射，
 * 使 SELECT/GROUP BY 与 WHERE（compileLeaf）同用契约列名（BUG-01 修复）；
 * 事实行内存访问（executeQuery）仍用种子字段名（GRAN_COL），不受影响 */
const SQL_COL = { prov: 'region_prov', city: 'region_city', c1: 'ind_c1', c2: 'ind_c2', month: 'month' };

function buildSql(state, role, norm) {
  const { reg } = state;
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

/* ============================ 8. 内置默认看板配置 ============================ */

/**
 * 【内置默认看板配置 —— 待 T07 替换】
 * mvp/data/dashboards.json 不存在时启用本内置配置（驾驶舱 + 宏观主题看板各一）。
 * T07 产出正式 dashboards.json 后，本段自动失效（启动时优先读文件）。
 * 结构完全遵循契约 §6 dashboard schema。
 */
const DEFAULT_DASHBOARDS = [
  {
    dashboardId: 'dash-cockpit', version: '1.0.0', title: '宏观经济运行驾驶舱', domain: 'cockpit',
    layout: { cols: 12, rowHeight: 64, note: '顶20%卡带/中55%趋势分布/底25%排名预警' },
    globalFilters: [
      { id: 'gf-time', dim: 'time', op: 'time_range', label: '时间', component: 'month-range', default: { range: ['2026-10', '2026-10'] } },
      { id: 'gf-region', dim: 'region', op: 'descendantOf', label: '地区', component: 'dim-tree', default: { value: '000000' } },
      { id: 'gf-industry', dim: 'industry', op: 'in', label: '行业', component: 'dim-multi-select', default: { values: ['C', 'I', 'M'] } },
    ],
    cards: [
      { cardId: 'card-gdp', metric: 'MACRO.GDP.VA0001', compare: ['yoy'], timeMode: 'latest', position: { x: 0, y: 0, w: 2, h: 2 } },
      { cardId: 'card-gdp-gr', metric: 'MACRO.GDP.GR0001', compare: ['yoy'], timeMode: 'latest', position: { x: 2, y: 0, w: 2, h: 2 } },
      { cardId: 'card-ind', metric: 'MACRO.IND.VA0002', compare: ['yoy'], timeMode: 'latest', position: { x: 4, y: 0, w: 2, h: 2 } },
      { cardId: 'card-cpi', metric: 'MACRO.CPI.IDX0003', compare: ['yoy'], timeMode: 'latest', position: { x: 6, y: 0, w: 2, h: 2 } },
      { cardId: 'card-inv', metric: 'MACRO.INV.CU0004', compare: ['yoy'], timeMode: 'latest', position: { x: 8, y: 0, w: 2, h: 2 } },
      { cardId: 'card-cons', metric: 'MACRO.CON.VA0005', compare: ['yoy'], timeMode: 'latest', position: { x: 10, y: 0, w: 2, h: 2 } },
      { cardId: 'card-trade', metric: 'MACRO.TRADE.VA0006', compare: ['yoy'], timeMode: 'latest', position: { x: 0, y: 2, w: 2, h: 2 } },
      { cardId: 'card-fin', metric: 'MACRO.FIN.VA0007', compare: ['yoy'], timeMode: 'latest', position: { x: 2, y: 2, w: 2, h: 2 } },
    ],
    charts: [
      {
        chartId: 'c1-region-rank', type: 'bar', title: 'GDP 当月值 · 省级排名', position: { x: 0, y: 4, w: 6, h: 6 },
        dataset: { metrics: ['MACRO.GDP.VA0001'], dimensions: [{ dim: 'region', granularity: 'province' }], time: { grain: 'month', range: ['2026-10', '2026-10'] }, sort: [{ by: 'MACRO.GDP.VA0001', order: 'desc' }], limit: 50 },
        drill: { dims: ['region'], initialPath: { region: 'ROOT' }, maxDepth: 2 },
        emits: [{ event: 'filter:click', dim: 'region', op: 'descendantOf' }],
        subscribes: [{ dim: 'industry', action: 'filter' }, { dim: 'time', action: 'filter' }],
      },
      {
        chartId: 'c2-gdp-trend', type: 'line', title: 'GDP 与规上工业 · 月度趋势', position: { x: 6, y: 4, w: 6, h: 6 },
        dataset: { metrics: ['MACRO.GDP.VA0001', 'MACRO.IND.VA0002'], dimensions: [{ dim: 'time', granularity: 'time_month' }], time: { grain: 'month', range: ['2026-01', '2026-10'], compare: ['yoy'] }, limit: 50 },
        drill: { dims: [], initialPath: {}, maxDepth: 2 },
        emits: [],
        subscribes: [{ dim: 'region', action: 'filter' }, { dim: 'industry', action: 'filter' }],
      },
      {
        chartId: 'c3-industry-mix', type: 'pie', title: 'GDP 行业大类构成', position: { x: 0, y: 10, w: 6, h: 6 },
        dataset: { metrics: ['MACRO.GDP.VA0001'], dimensions: [{ dim: 'industry', granularity: 'industry_c2' }], time: { grain: 'month', range: ['2026-10', '2026-10'] }, sort: [{ by: 'MACRO.GDP.VA0001', order: 'desc' }], limit: 50 },
        drill: { dims: ['industry'], initialPath: { industry: 'ROOT' }, maxDepth: 2 },
        emits: [{ event: 'filter:click', dim: 'industry', op: 'in' }],
        subscribes: [{ dim: 'region', action: 'filter' }],
      },
      {
        chartId: 'c4-alert-table', type: 'table', title: '规上工业同比异常明细（负增长预警）', position: { x: 6, y: 10, w: 6, h: 6 },
        dataset: { metrics: ['MACRO.IND.VA0002'], dimensions: [{ dim: 'region', granularity: 'province' }, { dim: 'time', granularity: 'time_month' }], time: { grain: 'month', range: ['2026-06', '2026-10'], compare: ['yoy'] }, sort: [{ by: 'MACRO.IND.VA0002', order: 'desc' }], limit: 50 },
        drill: { dims: ['region'], initialPath: { region: 'ROOT' }, maxDepth: 2 },
        emits: [],
        subscribes: [{ dim: 'region', action: 'filter' }, { dim: 'industry', action: 'filter' }],
      },
    ],
  },
  {
    dashboardId: 'dash-macro', version: '1.0.0', title: '宏观经济主题看板', domain: 'macro',
    layout: { cols: 12, rowHeight: 64, note: '主题看板：六卡 + 构成/趋势/排名' },
    globalFilters: [
      { id: 'gf-time', dim: 'time', op: 'time_range', label: '时间', component: 'month-range', default: { range: ['2026-10', '2026-10'] } },
      { id: 'gf-region', dim: 'region', op: 'descendantOf', label: '地区', component: 'dim-tree', default: { value: '000000' } },
    ],
    cards: [
      { cardId: 'card-gdp', metric: 'MACRO.GDP.VA0001', compare: ['yoy'], timeMode: 'latest', position: { x: 0, y: 0, w: 2, h: 2 } },
      { cardId: 'card-gdp-gr', metric: 'MACRO.GDP.GR0001', compare: ['yoy'], timeMode: 'latest', position: { x: 2, y: 0, w: 2, h: 2 } },
      { cardId: 'card-ind', metric: 'MACRO.IND.VA0002', compare: ['yoy'], timeMode: 'latest', position: { x: 4, y: 0, w: 2, h: 2 } },
      { cardId: 'card-cons', metric: 'MACRO.CON.VA0005', compare: ['yoy'], timeMode: 'latest', position: { x: 6, y: 0, w: 2, h: 2 } },
      { cardId: 'card-trade', metric: 'MACRO.TRADE.VA0006', compare: ['yoy'], timeMode: 'latest', position: { x: 8, y: 0, w: 2, h: 2 } },
      { cardId: 'card-engi', metric: 'MACRO.ENGI.GR0009', compare: ['yoy'], timeMode: 'latest', position: { x: 10, y: 0, w: 2, h: 2 } },
    ],
    charts: [
      {
        chartId: 'c1-industry-mix', type: 'pie', title: '规上工业 · 行业大类构成', position: { x: 0, y: 4, w: 4, h: 6 },
        dataset: { metrics: ['MACRO.IND.VA0002'], dimensions: [{ dim: 'industry', granularity: 'industry_c2' }], filters: [{ dim: 'industry', op: 'in', values: ['C'] }], time: { grain: 'month', range: ['2026-10', '2026-10'] }, limit: 50 },
        drill: { dims: ['industry'], initialPath: { industry: 'C' }, maxDepth: 2 },
        emits: [{ event: 'filter:click', dim: 'industry', op: 'in' }],
        subscribes: [{ dim: 'region', action: 'filter' }],
      },
      {
        chartId: 'c2-ind-trend', type: 'line', title: '规上工业增加值 · 月度趋势（含同比）', position: { x: 4, y: 4, w: 8, h: 6 },
        dataset: { metrics: ['MACRO.IND.VA0002'], dimensions: [{ dim: 'time', granularity: 'time_month' }], time: { grain: 'month', range: ['2026-01', '2026-10'], compare: ['yoy'] }, limit: 50 },
        drill: { dims: [], initialPath: {}, maxDepth: 2 },
        emits: [],
        subscribes: [{ dim: 'region', action: 'filter' }, { dim: 'industry', action: 'filter' }],
      },
      {
        chartId: 'c3-city-rank', type: 'bar', title: 'GDP 当月值 · 市级排名（省用户=本省各市）', position: { x: 0, y: 10, w: 12, h: 6 },
        dataset: { metrics: ['MACRO.GDP.VA0001'], dimensions: [{ dim: 'region', granularity: 'city' }], time: { grain: 'month', range: ['2026-10', '2026-10'] }, sort: [{ by: 'MACRO.GDP.VA0001', order: 'desc' }], limit: 50 },
        drill: { dims: ['region'], initialPath: { region: 'ROOT' }, maxDepth: 2 },
        emits: [{ event: 'drill:nav', dim: 'region', op: 'descendantOf' }],
        subscribes: [{ dim: 'industry', action: 'filter' }],
      },
    ],
  },
];

/* ============================ 9. HTTP 服务 ============================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function createApp(options = {}) {
  const reg = buildRegistry(options.dataDir || DATA_DIR);
  DATA_MIN_REF = reg.DATA_MIN;
  const webRoot = options.webDir || WEB_ROOT;

  const state = {
    reg,
    watermark: 'wm-20261108-01',
    metricDefVersion: 'md-3',
    dimTreeVersion: 'dt-1',
    cache: new Map(),   // sha256全量键 → { at, resp }
    traceSeq: 0,
    audit: [],          // 审计日志（内存环形，最近 500 条）
  };

  // 看板配置：优先 mvp/data/dashboards.json（T07 产出），否则内置默认
  let dashboards;
  const dashFile = path.join(options.dataDir || DATA_DIR, 'dashboards.json');
  if (fs.existsSync(dashFile)) {
    const doc = loadJson(dashFile);
    dashboards = Array.isArray(doc) ? doc : doc.dashboards || [];
  } else {
    dashboards = DEFAULT_DASHBOARDS; // 【待 T07 替换：见 DEFAULT_DASHBOARDS 注释】
  }
  const dashIdx = new Map(dashboards.map((d) => [d.dashboardId, d]));

  const nextTraceId = () => 't-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(++state.traceSeq).padStart(4, '0');
  const audit = (entry) => { state.audit.push(entry); if (state.audit.length > 500) state.audit.shift(); };

  const sendJson = (res, status, obj) => {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  };
  const sendError = (res, err, traceId) => {
    const e = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL', '服务端内部错误', {});
    sendJson(res, e.status, { error: { code: e.code, message: e.message, detail: e.detail, traceId } });
  };

  /** RLS 裁剪说明（契约 §2.6.3） */
  const rlsApplied = (role) => {
    const d = reg.ROLES.get(role);
    if (d.rls.type !== 'path_prefix') return null;
    return { dim: 'region', predicate: `path LIKE '${d.bind_node_path}%'`, scopePath: d.bind_node_path, visibleRoot: d.bind_node };
  };

  /* ---- POST /api/v1/query 主流程 ---- */
  function handleQuery(req, res, rawBody, role, traceId) {
    const t0 = Date.now();
    let raw;
    try { raw = JSON.parse(rawBody.toString('utf8') || 'null'); }
    catch { throw schemaInvalid('', '请求体不是合法 JSON'); }

    // ① 校验 + 规范化 + 消解（未注册指标 → 404；策略冲突 → 403；结构非法 → 400）
    const norm = normalizeQuery(raw, reg);

    // ② 缓存键（契约 §2.7 四因子 + role 桶；canonicalDSL 已剥离 sourceChartId/superseded）
    const keyFull = sha256hex(['v1', role, norm.canonical, state.watermark, state.metricDefVersion, state.dimTreeVersion].join('|'));
    const cached = state.cache.get(keyFull);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      const resp = { ...cached.resp, meta: { ...cached.resp.meta, cacheHit: true, elapsedMs: Date.now() - t0 } };
      audit({ t: new Date().toISOString(), traceId, role, path: '/api/v1/query', cacheHit: true, cacheKey: keyFull.slice(0, 8), stripped: norm.stripped });
      return sendJson(res, 200, resp);
    }

    // ③ 执行（RLS 注入 + 聚合 + 同环比）
    const result = executeQuery(state, role, norm);
    const sql = buildSql(state, role, norm);

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
    audit({ t: new Date().toISOString(), traceId, role, path: '/api/v1/query', cacheHit: false, cacheKey: keyFull.slice(0, 8), canonical: norm.canonical, stripped: norm.stripped, sql, traceId });
    sendJson(res, 200, resp);
  }

  /* ---- GET /api/v1/meta/metrics ---- */
  function handleMetaMetrics(res, url, role, traceId) {
    const q = url.searchParams;
    const toContractPolicy = (rt) => rt.policy;
    const rows = [];
    for (const def of reg.metricsDoc.metrics) {
      const rt = reg.M.get(def.code);
      const item = {
        code: def.code,
        name: def.name,
        domain: def.theme,
        unit: def.unit,
        aggType: def.agg_type,
        comparePolicy: toContractPolicy(rt),
        polarity: def.polarity === 'negative' ? 'inverse' : def.polarity, // 契约 §3.2 枚举 positive|inverse（种子字典用 negative，出口统一映射）
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
      // 过滤参数：domain / q（名称/编码/责任处室）/ agg_type / compare_policy（兼容种子值与契约值）/ polarity
      if (q.get('domain') && item.domain !== q.get('domain')) continue;
      if (q.get('agg_type') && item.aggType !== q.get('agg_type')) continue;
      if (q.get('polarity') && item.polarity !== q.get('polarity')) continue;
      const cp = q.get('compare_policy');
      if (cp && item.comparePolicy !== cp && def.compare_policy !== cp) continue;
      const kw = q.get('q');
      if (kw && !(item.name.includes(kw) || item.code.includes(kw) || item.ownerDept.includes(kw))) continue;
      rows.push(item);
    }
    sendJson(res, 200, { data: rows, meta: { count: reg.metricsDoc.metrics.length, metricDefVersion: state.metricDefVersion, filtered: rows.length } });
  }

  /* ---- GET /api/v1/meta/dims（RLS 裁剪维度树，D8）---- */
  function handleMetaDims(res, url, role, traceId) {
    const q = url.searchParams;
    const dim = q.get('dim');
    if (dim !== 'region' && dim !== 'industry') {
      throw schemaInvalid('/dim', 'dim 仅支持 region|industry');
    }
    const depth = q.get('depth') === null ? 1 : parseInt(q.get('depth'), 10);
    if (![1, 2].includes(depth)) throw schemaInvalid('/depth', 'depth 仅支持 1|2');

    const roleDef = reg.ROLES.get(role);
    const scope = roleDef.rls.type === 'path_prefix' && dim === 'region' ? roleDef.bind_node_path : null; // 仅 region 受 RLS

    // parent 解析：缺省=根（leader 的 region 根为全国；prov-* 自动改写为本省节点）
    let parentCode = q.get('parent');
    if (dim === 'region') {
      if (parentCode === 'ROOT' || parentCode === null) parentCode = scope ? roleDef.bind_node : '000000';
      if (scope && parentCode !== roleDef.bind_node && parentCode !== '000000') {
        // 显式请求的 parent 必须在可见子树内
        const node = reg.nodeIdx.region.get(parentCode);
        if (!node) throw schemaInvalid('/parent', 'parent 不在维表：' + parentCode);
        if (!node.path.startsWith(scope)) return sendJson(res, 200, { data: [], meta: { dim, parent: parentCode, count: 0, dimTreeVersion: state.dimTreeVersion, rlsApplied: rlsApplied(role) } }); // D7 同语义：越界 → 空集
      }
    } else if (parentCode === null || parentCode === 'ROOT') {
      parentCode = null; // industry 根=门类（parent=null 的节点）
    }
    if (parentCode != null && !reg.nodeIdx[dim].has(parentCode)) {
      throw schemaInvalid('/parent', 'parent 不在维表：' + parentCode);
    }

    // BFS 取 depth 层（保持 dims.json 声明顺序）
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
    sendJson(res, 200, {
      data: out,
      meta: {
        dim, parent: parentCode, count: out.length, dimTreeVersion: state.dimTreeVersion,
        rlsApplied: rlsApplied(role),
      },
    });
  }

  /* ---- GET /api/v1/meta/dashboard/:id ---- */
  function handleDashboard(res, id, traceId) {
    const d = dashIdx.get(id);
    if (!d) throw new ApiError(404, 'DASHBOARD_NOT_FOUND', '看板不存在：' + id, { dashboardId: id, known: [...dashIdx.keys()] });
    const etag = 'cfg-' + sha256hex(stableStringify(d)).slice(0, 4);
    sendJson(res, 200, { data: d, meta: { version: d.version, etag, dimTreeVersion: state.dimTreeVersion, metricDefVersion: state.metricDefVersion } });
  }

  /* ---- POST /api/v1/admin/watermark：bump 版本因子 → 换键即失效（D11）---- */
  function handleBump(res, rawBody) {
    let factor = 'watermark';
    try {
      const b = JSON.parse(rawBody.toString('utf8') || '{}');
      if (b && typeof b.factor === 'string') factor = b.factor;
    } catch { /* 空 body 走默认 watermark */ }
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    if (factor === 'metricDef') {
      const n = parseInt(state.metricDefVersion.split('-')[1], 10) + 1;
      state.metricDefVersion = 'md-' + n;
    } else if (factor === 'dimTree') {
      const n = parseInt(state.dimTreeVersion.split('-')[1], 10) + 1;
      state.dimTreeVersion = 'dt-' + n;
    } else if (factor === 'watermark') {
      const seq = (parseInt((state.watermark.split('-')[2] || '1'), 10) || 1) + 1;
      state.watermark = `wm-${ymd}-${String(seq).padStart(2, '0')}`;
    } else {
      throw schemaInvalid('/factor', 'factor 仅支持 watermark|metricDef|dimTree');
    }
    const cleared = state.cache.size;
    state.cache.clear(); // 主动失效：换键 + 清空，TTL 300s 仅兜底
    audit({ t: new Date().toISOString(), path: '/api/v1/admin/watermark', factor });
    sendJson(res, 200, {
      data: { factor, watermark: state.watermark, metricDefVersion: state.metricDefVersion, dimTreeVersion: state.dimTreeVersion, cleared },
      meta: {},
    });
  }

  /* ---- 静态服务 ../web（五重防穿越 + 扩展名白名单） ---- */
  const STATIC_ROOT = path.resolve(webRoot);
  const STATIC_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.ico', '.woff', '.woff2', '.map']);
  function serveStatic(res, pathname) {
    // ① 解码后再校验：URL 编码（%2e%2e%2f）不能绕过；非法编码直接拒绝
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { decoded = null; }
    if (decoded == null || decoded.includes('\0')) {
      return sendError(res, new ApiError(403, 'FORBIDDEN', '路径非法', {}), nextTraceId());
    }
    const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    // ② 拒绝 . / .. 段（规范化前拦截，双平台分隔符都算）
    if (rel.split(/[\\/]/).some((seg) => seg === '..' || seg === '.')) {
      return sendError(res, new ApiError(403, 'FORBIDDEN', '路径非法', {}), nextTraceId());
    }
    const file = path.resolve(STATIC_ROOT, rel);
    // ③ 规范化后边界校验
    if (file !== STATIC_ROOT && !file.startsWith(STATIC_ROOT + path.sep)) {
      return sendError(res, new ApiError(403, 'FORBIDDEN', '路径非法', {}), nextTraceId());
    }
    // ④ 扩展名白名单（不存在的扩展一律拒绝）
    if (!STATIC_EXT.has(path.extname(file).toLowerCase())) {
      return sendError(res, new ApiError(403, 'FORBIDDEN', '资源类型不允许', { path: rel }), nextTraceId());
    }
    // ⑤ realpath 校验：符号链接不得指向根目录之外
    fs.realpath(file, (rpErr, real) => {
      if (rpErr) return sendError(res, new ApiError(404, 'NOT_FOUND', '静态资源不存在：' + rel, { path: rel }), nextTraceId());
      if (real !== STATIC_ROOT && !real.startsWith(STATIC_ROOT + path.sep)) {
        return sendError(res, new ApiError(403, 'FORBIDDEN', '路径非法', {}), nextTraceId());
      }
      fs.readFile(real, (err, buf) => {
        if (err) return sendError(res, new ApiError(404, 'NOT_FOUND', '静态资源不存在：' + rel, { path: rel }), nextTraceId());
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream',
          'Content-Length': buf.length,
          // 纵深防御：即便出现注入，脚本也无法外连/加载第三方资源
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(buf);
      });
    });
  }

  const server = http.createServer((req, res) => {
    const traceId = nextTraceId();
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendError(res, schemaInvalid('', 'URL 非法'), traceId); }
    const p = url.pathname;

    const needBody = new Promise((resolve) => {
      if (req.method !== 'POST') return resolve(null);
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { req.destroy(); resolve(undefined); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', () => resolve(undefined));
    });

    needBody.then((body) => {
      if (body === undefined) return sendError(res, new ApiError(400, 'DSL_SCHEMA_INVALID', '请求体超过 1MB', {}), traceId);
      try {
        // ---- 路由 ----
        if (p === '/api/v1/query' && req.method === 'POST') {
          const role = req.headers['x-role'];
          if (!role || !KNOWN_ROLES.has(role)) {
            throw new ApiError(401, 'UNAUTHENTICATED', 'X-Role 缺失或非法（leader|prov-js|prov-gd）', { received: role || null });
          }
          return handleQuery(req, res, body, role, traceId);
        }
        if (p === '/api/v1/admin/watermark' && req.method === 'POST') {
          return handleBump(res, body);
        }
        if (p.startsWith('/api/v1/meta/')) {
          const role = req.headers['x-role'];
          if (!role || !KNOWN_ROLES.has(role)) {
            throw new ApiError(401, 'UNAUTHENTICATED', 'X-Role 缺失或非法（leader|prov-js|prov-gd）', { received: role || null });
          }
          if (p === '/api/v1/meta/metrics' && req.method === 'GET') return handleMetaMetrics(res, url, role, traceId);
          if (p === '/api/v1/meta/dims' && req.method === 'GET') return handleMetaDims(res, url, role, traceId);
          const m = p.match(/^\/api\/v1\/meta\/dashboard\/([A-Za-z0-9_-]+)$/);
          if (m && req.method === 'GET') return handleDashboard(res, m[1], traceId);
          throw new ApiError(404, 'NOT_FOUND', 'API 路由不存在：' + p, { path: p });
        }
        if (p.startsWith('/api/')) {
          throw new ApiError(404, 'NOT_FOUND', 'API 路由不存在：' + p, { path: p });
        }
        if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, p);
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '方法不允许', { method: req.method });
      } catch (err) {
        sendError(res, err, traceId);
        if (!(err instanceof ApiError)) console.error('[INTERNAL]', err); // 500 兜底留痕
      }
    });
  });

  return { server, state };
}

/**
 * 启动服务（供 index.js 直跑与 smoke.js 复用）
 * options: { port=3000, dataDir, webDir, quiet }
 */
function startServer(options = {}) {
  const port = options.port != null ? options.port : (parseInt(process.env.PORT || '3000', 10));
  const app = createApp(options);
  return new Promise((resolve) => {
    app.server.listen(port, '127.0.0.1', () => {
      const addr = app.server.address();
      if (!options.quiet) {
        console.log(`[T05 语义层服务] 已启动: http://127.0.0.1:${addr.port}`);
        console.log(`  数据目录: ${options.dataDir || DATA_DIR}`);
        console.log(`  静态目录: ${options.webDir || WEB_ROOT}`);
        console.log(`  指标 ${app.state.reg.M.size} 个 | 事实行 ${app.state.reg.facts.length} | 角色 ${app.state.reg.ROLES.size}`);
      }
      resolve({ server: app.server, port: addr.port, state: app.state });
    });
  });
}

/* ---- 直跑入口（node index.js [port]）---- */
if (require.main === module) {
  const portArg = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
  startServer({ port: portArg }).then(({ port }) => {
    console.log(`用法: node index.js [port]   （当前端口 ${port}，默认 3000）`);
  });
}

module.exports = { startServer, createApp, normalizeQuery, executeQuery, buildSql, shiftMonth, ApiError };

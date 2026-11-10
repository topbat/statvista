'use strict';
/* ============================================================
 * 统计数据可视表平台 · 前端单页应用（零构建 vanilla JS + 本地 ECharts）
 * 依据：docs/mvp/04-UI交互规范.md（UI/交互/三态/URL 终态）
 *       docs/mvp/03-DSL与API契约.md（/api/v1 端点、请求响应结构、错误码）
 * 要点：红涨绿跌箭头+数值同显；逆指标按 polarity 反转文案；
 *       联动总线 filter:click（sourceChartId 溯源）；下钻栈与 URL 同步；
 *       三态（骨架屏/空数据二分/无权限）；X-Role 身份切换全量重查。
 * ============================================================ */

/* ==================== 1. 常量与兜底配置 ==================== */

const API_BASE = '/api/v1';            // 静态服务与 API 同源（端口 3000）
const TIME_MIN = '2025-01';            // 种子数据时间窗起点（22 个月）
const TIME_MAX = '2026-10';            // 最新月
const DEFAULT_TF = [TIME_MIN, TIME_MAX];
const LATEST = TIME_MAX;

/* 身份 → 绑定机构（RLS 由服务端注入，前端仅做越权状态钳制提示） */
const ROLE_HOME = {
  'prov-js': { code: '320000', name: '江苏省' },
  'prov-gd': { code: '440000', name: '广东省' }
};
const ROLE_NAME = { leader: 'leader（全国）', 'prov-js': 'prov-js（江苏）', 'prov-gd': 'prov-gd（广东）' };

/* 驾驶舱 8 指标卡（PRD §5.1 A：#1#3#4#5#6#9#10#15） */
const COCKPIT_CARDS = [
  'MACRO.GDP.VA0001',   // GDP（当月值）
  'MACRO.IND.VA0002',   // 规上工业增加值
  'MACRO.CPI.IDX0003',  // CPI 当月同比
  'MACRO.EMP.CU0008',   // 城镇新增就业（累计）
  'MACRO.INV.CU0004',   // 固定资产投资（累计）
  'MACRO.CON.VA0005',   // 社会消费品零售总额
  'MACRO.ENGI.GR0009',  // 单位 GDP 能耗降低率（逆）
  'TECH.HTI.VA0005'     // 高技术产业增加值
];

/* 主题看板配置（同一模板换参数；卡片清单可被 /meta/dashboard 下发覆盖） */
const THEME_CONF = {
  macro: {
    title: '宏观经济主题看板',
    intro: 'GDP、工业、消费、投资、能耗等核心指标运行情况',
    cards: ['MACRO.GDP.VA0001', 'MACRO.GDP.GR0001', 'MACRO.IND.VA0002',
            'MACRO.CPI.IDX0003', 'MACRO.INV.CU0004', 'MACRO.CON.VA0005'],
    main: 'MACRO.GDP.VA0001'
  },
  tech: {
    title: '科技创新主题看板',
    intro: 'R&D 经费、投入强度、专利、高技术产业等创新指标',
    cards: ['TECH.RD.CU0001', 'TECH.RD.INT0002', 'TECH.PAT.VA0003',
            'TECH.PAT.SH0004', 'TECH.HTI.VA0005', 'TECH.RDP.SN0006'],
    main: 'TECH.PAT.VA0003'
  }
};

/* 预埋异常清单（PRD §6 / 数据字典 §6：A1/A2/A3，J1 异常叙事载体） */
const PRESET_ALERTS = [
  { id: 'A1', level: 'red', metric: '规上工业增加值', metricCode: 'MACRO.IND.VA0002',
    region: '江苏省', regionCode: '320000', delta: '同比 −4.5pct，连续 5 月为负且逐月加深', month: '2026-10' },
  { id: 'A2', level: 'orange', metric: '单位 GDP 能耗降低率（逆）', metricCode: 'MACRO.ENGI.GR0009',
    region: '江苏省', regionCode: '320000', delta: '−12.48pct，降幅扩大（逆指标变差）', month: '2026-10' },
  { id: 'A3', level: 'info', metric: 'GDP 累计同比增速', metricCode: 'MACRO.GDP.GR0001',
    region: '江苏省', regionCode: '320000', delta: '3.88%，省域排名垫底', month: '2026-10' }
];

/* 指标元数据兜底表（/api/v1/meta/metrics 不可达时使用，字段同契约 §3.2；
 * 数据来源：docs/mvp/02-数据字典与种子数据.md §2.2/§2.3） */
const FALLBACK_META = [
  { code: 'MACRO.GDP.VA0001', name: 'GDP（当月值）', unit: '亿元', aggType: 'sum', comparePolicy: 'window_sum', polarity: 'positive', formula: 'Σ 分地区 × 分行业当月增加值', ownerDept: '综合处', updateFreq: 'monthly' },
  { code: 'MACRO.GDP.GR0001', name: 'GDP 累计同比增速', unit: '%', aggType: 'ratio', comparePolicy: 'compare_then_compute', polarity: 'positive', formula: '(本年累计 VA0001 / 上年同期累计 VA0001 − 1) × 100', numeratorRef: 'MACRO.GDP.VA0001', denominatorRef: 'MACRO.GDP.VA0001@py', ownerDept: '综合处', updateFreq: 'monthly' },
  { code: 'MACRO.IND.VA0002', name: '规上工业增加值（当月值）', unit: '亿元', aggType: 'sum', comparePolicy: 'window_sum', polarity: 'positive', formula: 'Σ 规模以上工业企业当月增加值', ownerDept: '工业处', updateFreq: 'monthly' },
  { code: 'MACRO.CPI.IDX0003', name: 'CPI 当月同比', unit: '%', aggType: 'ratio', comparePolicy: 'compare_then_compute', polarity: 'positive', formula: '(当月定基价格水平 / 上年同月 − 1) × 100', numeratorRef: 'MACRO.CPI.LVL0011', denominatorRef: 'MACRO.CPI.LVLP0012', ownerDept: '价格处', updateFreq: 'monthly' },
  { code: 'MACRO.INV.CU0004', name: '固定资产投资（本年累计）', unit: '亿元', aggType: 'cumulative', comparePolicy: 'none', polarity: 'positive', formula: '本年 1 月至当月累计完成额', ownerDept: '投资处', updateFreq: 'monthly' },
  { code: 'MACRO.CON.VA0005', name: '社会消费品零售总额（当月值）', unit: '亿元', aggType: 'sum', comparePolicy: 'window_sum', polarity: 'positive', formula: 'Σ 当月社会消费品零售额', ownerDept: '贸易处', updateFreq: 'monthly' },
  { code: 'MACRO.TRADE.VA0006', name: '货物进出口总额（当月值）', unit: '亿元', aggType: 'sum', comparePolicy: 'window_sum', polarity: 'positive', formula: 'Σ 当月货物进出口额', ownerDept: '贸易处', updateFreq: 'monthly' },
  { code: 'MACRO.FIN.VA0007', name: '一般公共预算收入（当月值）', unit: '亿元', aggType: 'sum', comparePolicy: 'window_sum', polarity: 'positive', formula: 'Σ 当月一般公共预算收入', ownerDept: '财政处', updateFreq: 'monthly' },
  { code: 'MACRO.EMP.CU0008', name: '城镇新增就业（本年累计）', unit: '万人', aggType: 'cumulative', comparePolicy: 'none', polarity: 'positive', formula: '本年 1 月至当月城镇新增就业累计', ownerDept: '就业处', updateFreq: 'monthly' },
  { code: 'MACRO.ENGI.GR0009', name: '单位 GDP 能耗降低率', unit: '%', aggType: 'ratio', comparePolicy: 'compare_then_compute', polarity: 'inverse', formula: '(1 − 当期单位能耗 / 上年同期单位能耗) × 100', numeratorRef: 'MACRO.ENGI.CON0010', denominatorRef: 'MACRO.GDP.VA0001', ownerDept: '能源处', updateFreq: 'monthly' },
  { code: 'TECH.RD.CU0001', name: 'R&D 经费支出（本年累计）', unit: '亿元', aggType: 'cumulative', comparePolicy: 'none', polarity: 'positive', formula: '本年 1 月至当月 R&D 经费累计支出', ownerDept: '科技处', updateFreq: 'monthly' },
  { code: 'TECH.RD.INT0002', name: 'R&D 投入强度（R&D/GDP）', unit: '%', aggType: 'ratio', comparePolicy: 'compare_then_compute', polarity: 'positive', formula: 'R&D 累计经费 / GDP 累计 × 100', numeratorRef: 'TECH.RD.CU0001', denominatorRef: 'MACRO.GDP.VA0001', ownerDept: '科技处', updateFreq: 'monthly' },
  { code: 'TECH.PAT.VA0003', name: '专利授权量（当月值）', unit: '件', aggType: 'sum', comparePolicy: 'window_sum', polarity: 'positive', formula: 'Σ 当月专利授权量', ownerDept: '知识产权处', updateFreq: 'monthly' },
  { code: 'TECH.PAT.SH0004', name: '发明专利授权占比', unit: '%', aggType: 'ratio', comparePolicy: 'compare_then_compute', polarity: 'positive', formula: '发明授权量 / 授权总量 × 100', numeratorRef: 'TECH.PAT.INV0013', denominatorRef: 'TECH.PAT.VA0003', ownerDept: '知识产权处', updateFreq: 'monthly' },
  { code: 'TECH.HTI.VA0005', name: '高技术产业增加值（当月值）', unit: '亿元', aggType: 'sum', comparePolicy: 'window_sum', polarity: 'positive', formula: 'Σ 高技术产业当月增加值', ownerDept: '高新处', updateFreq: 'monthly' },
  { code: 'TECH.RDP.SN0006', name: '研发人员全时当量（期末值）', unit: '万人年', aggType: 'snapshot', comparePolicy: 'none', polarity: 'positive', formula: '期末研发人员全时当量', ownerDept: '科技处', updateFreq: 'monthly' }
];

/* 维度树根节点兜底（数据字典 §3：5 省 / 3 门类） */
const FALLBACK_DIM_ROOTS = {
  region: [
    { code: '320000', name: '江苏省', isLeaf: false },
    { code: '440000', name: '广东省', isLeaf: false },
    { code: '330000', name: '浙江省', isLeaf: false },
    { code: '370000', name: '山东省', isLeaf: false },
    { code: '520000', name: '贵州省', isLeaf: false }
  ],
  industry: [
    { code: 'C', name: '制造业', isLeaf: false },
    { code: 'I', name: '信息传输、软件和信息技术服务业', isLeaf: false },
    { code: 'M', name: '科学研究和技术服务业', isLeaf: false }
  ]
};

/* 错误码 → 中文提示（契约 §2.4.2） */
const ERR_ZH = {
  DSL_SCHEMA_INVALID: '请求参数不合法',
  METRIC_NOT_FOUND: '指标编码未注册',
  DIM_MISMATCH: '多指标不属于同一数据集，维度不兼容',
  BAD_FILTER: '过滤条件不合法',
  INVALID_TIME_RANGE: '时间范围不合法（应在 ' + TIME_MIN + ' ~ ' + TIME_MAX + ' 内）',
  COMPARE_POLICY_FORBIDDEN: '该指标口径禁止此比较（如累计指标禁用环比）',
  FORBIDDEN_BY_RLS: '暂无权限查看该数据',
  UNAUTHENTICATED: '身份缺失或非法，请重新选择身份',
  INTERNAL: '服务端内部错误'
};

/* 结构化字段中文标签 */
const AGG_LABEL = { sum: '求和', ratio: '比值', cumulative: '累计', snapshot: '快照' };
const CMP_LABEL = { window_sum: '窗口和比较', compare_then_compute: '先比后算', none: '不比较', direct: '直接比较', cumulative: '累计口径', snapshot: '快照同比' };
const POL_LABEL = { positive: '正', inverse: '逆', negative: '逆' };
const FREQ_LABEL = { monthly: '月度', quarterly: '季度', yearly: '年度' };

/* 月份工具（YYYY-MM 字符串可按字典序比较） */
const MONTHS = (() => {
  const out = []; let y = +TIME_MIN.slice(0, 4), m = +TIME_MIN.slice(5, 7);
  const Y = +TIME_MAX.slice(0, 4), M = +TIME_MAX.slice(5, 7);
  while (y < Y || (y === Y && m <= M)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
})();
function monthsBack(month, n) { const i = MONTHS.indexOf(month); return MONTHS[Math.max(0, i - n)]; }
function monthsIn(a, b) { return MONTHS.filter(m => m >= a && m <= b); }

/* ECharts 字体栈；图表 chrome（T28 变量同步式主题）：
 * 不用内置 dark 主题——init 时读 getComputedStyle CSS 变量构造主题对象（echTheme），
 * html[data-theme] 切换后 refreshChartChrome() 重读 + rethemeCharts() 全实例 dispose+重挂载 */
const CAT_VARS = ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-7', '--cat-8'];
const FONT_STACK = '-apple-system,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif';
let CHART_CHROME = null;
function cssVarRead(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) { return fallback; }
}
function refreshChartChrome() {
  CHART_CHROME = {
    cat: CAT_VARS.map(n => cssVarRead(n, '#1677FF')),
    text1: cssVarRead('--text-1', '#1F2329'),
    text2: cssVarRead('--text-2', '#4E5969'),
    text3: cssVarRead('--text-3', '#86909C'),
    border: cssVarRead('--border', '#D9DEE8'),
    splitLine: cssVarRead('--split-line', '#E5EAF2'),
    tooltipBg: cssVarRead('--tooltip-bg', '#FFFFFF'),
    tooltipBorder: cssVarRead('--tooltip-border', '#D9DEE8'),
    tooltipFg: cssVarRead('--tooltip-fg', '#1F2329'),
    up: cssVarRead('--up', '#D32029'),
    down: cssVarRead('--down', '#08979C'),
    flat: cssVarRead('--flat', '#86909C'),
    alert: cssVarRead('--alert', '#D4380D'),
    primary: cssVarRead('--primary', '#1677FF'),
    cardBg: cssVarRead('--bg-card', '#FFFFFF'),
    mapNeg: cssVarRead('--map-neg', '#D32029'),
    mapNegDeep: cssVarRead('--map-neg-deep', '#7A0C10'),
    mapPos: cssVarRead('--map-pos', '#4096FF'),
    mapPosDeep: cssVarRead('--map-pos-deep', '#0958D9'),
    mapNone: cssVarRead('--map-none', '#C9CDD4'),
    mapHover: cssVarRead('--map-hover', '#AEB8CB')
  };
  return CHART_CHROME;
}
function chrome() { return CHART_CHROME || refreshChartChrome(); }

/* ==================== 2. 全局状态 ==================== */

let ROLE = localStorage.getItem('sv-role') || 'leader';
let METAS = {};                 // code -> 元数据
let META_LIST = [];             // 字典页列表
let DIM_NAMES = {};             // code -> 名称（面包屑/胶囊翻译）
let DIM_ROOTS = { region: [], industry: [] };   // 维度根节点（下拉/树）
const TREE_CHILDREN = { region: {}, industry: {} };  // 懒加载子节点缓存
const chartMap = new Map();     // ECharts 实例登记（dispose 防泄漏）
const memo = {};                // 不订阅联动的区域（指标卡带/环形图）请求备忘
let reqSeq = 0;                 // 异步竞态令牌：渲染代际
let lastRenderedUrl = null;
let lastQueryMeta = null;       // 最近一次 /query 响应 meta（缓存调试面板数据源，§4.7）
let curSt = null;               // 主题看板当前终态（renderTheme 时刷新）
let curThemeId = 'macro';
let thTrendGran = 'industry_c1';  // C2 图私有粒度（门类|大类，不写回全局）
const DICT_FACETS = { domain: '', agg: '', cmp: '', pol: '' };  // 字典侧栏筛选（不入 URL）

/* 联动事件总线（04 规范 §3.3/§3.8：{type, source, payload} 信封） */
const bus = {
  handlers: {},
  on(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
  emit(type, payload) {
    (this.handlers[type] || []).forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } });
  }
};

/* ==================== 3. 基础工具 ==================== */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* —— DOMPurify 结构级消毒（T24）：esc() 文本级转义 + DOMPurify 结构级白名单渲染双保险。
 * 所有 innerHTML 注入点统一经 setHtml 写入；默认配置保留 data-*、style、svg（本应用自身外壳所需），
 * 剥离 script/onerror/javascript: 等攻击载荷；库缺失或不受支持时退化为第三层 strip 兜底（T31 加固），
 * 不再原样注入。 */
function sanitizeHtml(html) {
  if (window.DOMPurify && window.DOMPurify.isSupported) return window.DOMPurify.sanitize(html);
  return String(html)
    .replace(/<\s*script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<\s*script[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}
function setHtml(el, html) {
  if (!el) return;
  el.innerHTML = sanitizeHtml(html);
}
function fmtNum(v, d) {
  if (v == null || v === '' || isNaN(v)) return '—';
  if (d == null) d = 1;
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: d });
}
/* 指标值格式化：% 类保留 2 位，件数取整，其余 1 位 */
function valFmt(meta, v) {
  if (v == null || isNaN(v)) return '—';
  const d = meta && meta.unit === '%' ? 2 : (meta && meta.unit === '件' ? 0 : 1);
  return fmtNum(v, d);
}
function isInverse(meta) { return !!meta && (meta.polarity === 'inverse' || meta.polarity === 'negative'); }
function harvestNames(res) {
  // 从查询响应行采集维度编码→名称映射（面包屑/胶囊翻译用）
  (res && res.data || []).forEach(row => {
    Object.values(row.dims || {}).forEach(d => { if (d && d.code && d.name) DIM_NAMES[d.code] = d.name; });
  });
}

/* —— fetch 封装：统一 X-Role / JSON / 错误码→中文 —— */
async function api(path, opts) {
  opts = opts || {};
  const init = { method: opts.method || 'GET', headers: { 'X-Role': ROLE } };
  if (opts.body != null) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  let resp;
  try { resp = await fetch(API_BASE + path, init); }
  catch (e) { throw { code: 'NETWORK', message: '无法连接服务端（' + API_BASE + '），请确认后端已启动' }; }
  let json = null;
  try { json = await resp.json(); } catch (e) { /* 空 body */ }
  if (!resp.ok) {
    const err = (json && json.error) || {};
    throw {
      code: err.code || ('HTTP_' + resp.status),
      message: err.message || ERR_ZH[err.code] || ('请求失败（HTTP ' + resp.status + '）'),
      traceId: err.traceId || ''
    };
  }
  if (path === '/query' && json && json.meta) {
    lastQueryMeta = json.meta;  // 缓存调试面板取数（§4.7）
    const pop = document.getElementById('cache-debug-pop');
    if (pop) renderCacheDebug();  // 浮层开着则实时刷新（D10 miss→hit 演示）
  }
  return json;
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/* —— ECharts 公共缺省（04 规范 §1.6；T28 起取色全部来自 CSS 变量 chrome）—— */
function baseOption() {
  const c = chrome();
  return {
    color: c.cat.slice(),
    animationDuration: 300,
    textStyle: { fontFamily: FONT_STACK, color: c.text2 },
    axisLabel: { fontSize: 11, color: c.text2 },
    splitLine: { lineStyle: { color: c.splitLine } },
    tooltip: {
      backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1,
      textStyle: { color: c.tooltipFg, fontSize: 12 },
      extraCssText: 'box-shadow:0 2px 8px rgba(17,31,44,.10);'
    }
  };
}
function deepMerge(dst, src) {
  for (const k in src) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], src[k]);
    else dst[k] = src[k];
  }
  return dst;
}
function mergeOption(over) { return deepMerge(baseOption(), over || {}); }
/* —— T28 变量同步式 ECharts 主题对象（palette/axis/tooltip/visualMap 全部由 CSS 变量构造） —— */
function echTheme() {
  const c = chrome();
  const axis = {
    axisLine: { lineStyle: { color: c.border } },
    axisTick: { lineStyle: { color: c.border } },
    axisLabel: { color: c.text2 },
    splitLine: { lineStyle: { color: c.splitLine } }
  };
  return {
    color: c.cat.slice(),
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT_STACK, color: c.text2 },
    title: { textStyle: { color: c.text1 }, subtextStyle: { color: c.text3 } },
    legend: { textStyle: { color: c.text2 } },
    categoryAxis: Object.assign({}, axis),
    valueAxis: Object.assign({}, axis),
    logAxis: Object.assign({}, axis),
    timeAxis: Object.assign({}, axis),
    tooltip: { backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, textStyle: { color: c.tooltipFg } },
    visualMap: { textStyle: { color: c.text3 } }
  };
}
/* mountChart：over 为「未合并 baseOption」的原始 option，或 () => option 工厂（推荐）；
 * 工厂形态是 T28 变量同步式的关键：语义色（柱色/地图分档/扇区色等）在每次挂载/重挂时
 * 现读 CSS 变量构造，主题切换 dispose+re-init 后配色即时跟随，而非沿用首绘快照；
 * handlers：[[eventName, fn], …]——dispose+re-init 后事件需重登记，故随缓存一起保存 */
const optCache = new Map();     // id -> {container, over, handlers}（T28 主题切换缓存重渲染，数据不重拉）
function resolveOver(over) { return typeof over === 'function' ? over() : over; }
function mountChart(container, id, over, handlers) {
  disposeChart(id);
  const ins = echarts.init(container, echTheme());
  ins.setOption(mergeOption(resolveOver(over)));
  chartMap.set(id, ins);
  optCache.set(id, { container: container, over: over, handlers: handlers || [] });
  return ins;
}
function disposeChart(id) {
  const c = chartMap.get(id);
  if (c) { c.dispose(); chartMap.delete(id); }
  optCache.delete(id);
}
function disposeAll() { chartMap.forEach(c => c.dispose()); chartMap.clear(); optCache.clear(); }
/* T28：主题变更 → 全部图表实例 dispose + re-init（复用 chartMap/optCache 实例管理防泄漏），
 * 用缓存 over + 新 chrome 重新 mergeOption，数据不重拉；容器已随页面卸载的实例直接出缓存 */
function rethemeCharts() {
  const entries = Array.from(optCache.entries());
  optCache.clear();
  entries.forEach(rec => {
    const c = rec[1].container;
    const old = chartMap.get(rec[0]);
    if (old) { old.dispose(); chartMap.delete(rec[0]); }   // 先 dispose 旧实例，防同 dom 双实例泄漏
    if (!c || !document.body.contains(c)) return;
    const ins = echarts.init(c, echTheme());
    /* resolveOver：工厂形态现读新主题 CSS 变量重建 option（语义色同步），对象形态原样重合并 */
    ins.setOption(mergeOption(resolveOver(rec[1].over)));
    (rec[1].handlers || []).forEach(h => ins.on(h[0], h[1]));
    chartMap.set(rec[0], ins);
    optCache.set(rec[0], rec[1]);
  });
}
window.addEventListener('resize', () => chartMap.forEach(c => c.resize()));

/* 颜色去饱和（联动"变暗35%+去饱和"视觉三件套：opacity .65 + saturate(.6) 的取色近似，§1.2-4） */
function desat(hex, f) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  const c = (v) => Math.round(v + (l - v) * f);
  return '#' + ((1 << 24) + (c(r) << 16) + (c(g) << 8) + c(b)).toString(16).slice(1);
}

/* ==================== 4. 同环比展示（红涨绿跌 + 逆指标，§3.6） ==================== */

/* 比较对象 → {dir, val, arrow}；ratio 型用点差 pct（rate=null），否则用比率 % */
function cmpView(cmp) {
  if (!cmp) return null;
  const isPct = cmp.rate == null;
  const n = isPct ? cmp.delta : cmp.rate * 100;
  if (n == null || isNaN(n)) return null;
  const dir = n > 0.05 ? 'up' : (n < -0.05 ? 'down' : 'flat');
  const val = Math.abs(n).toFixed(1) + (isPct ? 'pct' : '%');
  const arrow = dir === 'up' ? '▲' : (dir === 'down' ? '▼' : '◇');
  return { dir, val, arrow, num: n };
}
/* 一行比较文案（箭头+数值同显；逆指标改写为"较上年上升/下降 X pct"） */
function cmpLineHtml(cmp, kind, meta) {
  const v = cmpView(cmp); if (!v) return '';
  const kindZh = kind === 'yoy' ? '同比' : '环比';
  if (isInverse(meta)) {
    const word = kind === 'yoy' ? '较上年' : '较上月';
    if (v.dir === 'flat') return '<span class="delta flat">◇ ' + word + '持平</span>';
    return '<span class="delta ' + v.dir + '">' + v.arrow + ' ' + word + (v.dir === 'up' ? '上升 ' : '下降 ') + v.val + '</span>';
  }
  if (v.dir === 'flat') return '<span class="delta flat">◇ 持平 ' + kindZh + '</span>';
  return '<span class="delta ' + v.dir + '">' + v.arrow + ' ' + v.val + '</span> ' + kindZh;
}
/* 表格单元格用（方向色箭头+数值） */
function cmpCellHtml(cmp) {
  const v = cmpView(cmp); if (!v) return '<span class="num">—</span>';
  return '<span class="delta ' + v.dir + '">' + v.arrow + ' ' + v.val + '</span>';
}

/* ==================== 5. 三态规范（§3.5） ==================== */

const ICON_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/><path d="M9 13h7M9 17h7"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3 2 21h20z"/><path d="M12 10v5"/><path d="M12 17.6v.4"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

function sklMetricCards(n, compact) {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += '<div class="mcard skl-card"><div class="skl skl-line w60"></div><div class="skl skl-big"></div><div class="skl skl-line w40"></div>' + (compact ? '' : '<div class="skl skl-line w50"></div>') + '</div>';
  }
  return s;
}
function sklChartHtml() {
  return '<div class="cc-head"><div class="skl skl-title"></div></div><div class="cc-body"><div class="skl skl-chart"></div></div>';
}
function sklTableHtml() {
  let rows = ''; for (let i = 0; i < 6; i++) rows += '<div class="skl skl-row"></div>';
  return '<div class="cc-head"><div class="skl skl-title"></div></div><div class="cc-body"><div class="skl-rows">' + rows + '</div></div>';
}
/* 空数据二分：meta.emptyReason 优先（契约 A-2/A-3），无则前端兜底判断 */
function emptyKind(res, hasFilterCtx) {
  const r = res && res.meta && res.meta.emptyReason;
  if (r === 'no-data' || r === 'filtered-empty') return r;
  return hasFilterCtx ? 'filtered-empty' : 'no-data';
}
function emptyBlock(kind) {
  if (kind === 'no-perm') {
    return '<div class="state-block"><div class="empty-ic">' + ICON_LOCK + '</div>' +
      '<div class="state-txt">暂无权限查看该数据</div>' +
      '<div class="state-actions"><button class="btn ghost" disabled>申请权限</button></div></div>';
  }
  if (kind === 'filtered-empty') {
    return '<div class="state-block"><div class="empty-ic warn">' + ICON_WARN + '</div>' +
      '<div class="state-txt">当前筛选下无数据</div><div class="state-sub">调整筛选或清除联动后重试</div>' +
      '<div class="state-actions"><button class="btn" data-clear-filters>清除筛选</button></div></div>';
  }
  return '<div class="state-block"><div class="empty-ic">' + ICON_DOC + '</div>' +
    '<div class="state-txt">暂无数据</div><div class="state-sub">更新频率：月（数据入库后自动出现）</div></div>';
}
function errorBlock(err) {
  err = err || {};
  return '<div class="state-block"><div class="empty-ic warn">' + ICON_WARN + '</div>' +
    '<div class="state-txt">加载失败：' + esc(err.message || '未知错误') + '</div>' +
    (err.traceId ? '<div class="state-sub">traceId：' + esc(err.traceId) + '</div>' : '') +
    '<div class="state-actions"><button class="btn" data-retry>重试</button></div></div>';
}
/* 图表容器外壳：标题/副题/工具行/漏斗角标（D14） */
function chartShellHtml(title, sub, tools, body, funnelFrom) {
  return '<div class="cc-head"><div class="cc-titles"><div class="cc-title">' + title + '</div>' +
    (sub ? '<div class="cc-sub">' + sub + '</div>' : '') + '</div>' +
    '<div class="cc-tools">' + (tools || '') + '</div>' +
    (funnelFrom ? '<span class="funnel-badge" data-tip="来自：' + esc(funnelFrom) + '"></span>' : '') +
    '</div><div class="cc-body">' + body + '</div>';
}

/* ==================== 6. 元数据与维度树加载 ==================== */

function normalizeMeta(m) {
  let policy = m.comparePolicy || m.compare_policy || 'none';
  /* 种子字典的 window_sum/none 映射为契约运行时策略（与服务端出口一致），
     保证字典 facet（direct/cumulative/snapshot）在兜底元数据下同样可用 */
  if (policy === 'window_sum') policy = 'direct';
  else if (policy === 'none') policy = (m.aggType || m.agg_type) === 'snapshot' ? 'snapshot' : ((m.aggType || m.agg_type) === 'cumulative' ? 'cumulative' : 'none');
  const o = {
    code: m.code,
    name: m.name || m.code,
    domain: m.domain || m.code.split('.')[0].toLowerCase(),
    unit: m.unit || '',
    aggType: m.aggType || m.agg_type || 'sum',
    comparePolicy: policy,
    polarity: m.polarity === 'negative' ? 'inverse' : (m.polarity || 'positive'),
    formula: m.formula || '',
    numeratorRef: m.numeratorRef || null,
    denominatorRef: m.denominatorRef || null,
    ownerDept: m.ownerDept || '',
    basisDocNo: m.basisDocNo || '统发〔2024〕XX 号（占位）',
    updateFreq: m.updateFreq || 'monthly',
    dataClass: m.dataClass || 'general',
    windowMonths: m.windowMonths || null,
    allowedCompares: m.allowedCompares || m.compareOps || (policy === 'none' ? ['yoy'] : ['yoy', 'mom'])
  };
  return o;
}
let metaWarned = false;
async function loadMetas() {
  try {
    const res = await api('/meta/metrics');
    META_LIST = (res.data || []).map(normalizeMeta);
  } catch (e) {
    META_LIST = FALLBACK_META.map(m => Object.assign({ basisDocNo: '统发〔2024〕XX 号（占位）', dataClass: 'general' }, m));
    if (!metaWarned) { metaWarned = true; setTimeout(() => toast('指标元数据端点不可达，已使用内置兜底元数据'), 0); }
  }
  METAS = {};
  META_LIST.forEach(m => { METAS[m.code] = m; });
  /* 看板配置（可选）：以服务端 cards 清单覆盖内置（"看板即 JSON"，D16） */
  for (const d of ['macro', 'tech']) {
    try {
      const r = await api('/meta/dashboard/dash-' + d);
      const cards = ((r.data && r.data.cards) || []).map(c => c.metric).filter(c => METAS[c]);
      if (cards.length) THEME_CONF[d].cards = cards.slice(0, 8);
    } catch (e) { /* 后端未就绪则沿用内置清单 */ }
  }
}
async function loadDimRoots() {
  try {
    const r = await api('/meta/dims?dim=region');
    DIM_ROOTS.region = (r.data || []).map(n => {
      if (n.short) DIM_SHORT[n.code] = n.short;   // 简称兜底表采集（T27 地图标签用）
      return { code: n.code, name: n.name, isLeaf: !!n.isLeaf };
    });
  } catch (e) { DIM_ROOTS.region = FALLBACK_DIM_ROOTS.region; }
  try {
    const r = await api('/meta/dims?dim=industry');
    DIM_ROOTS.industry = (r.data || []).map(n => ({ code: n.code, name: n.name, isLeaf: !!n.isLeaf }));
  } catch (e) { DIM_ROOTS.industry = FALLBACK_DIM_ROOTS.industry; }
  DIM_ROOTS.region.concat(DIM_ROOTS.industry).forEach(n => { DIM_NAMES[n.code] = n.name; });
}
async function loadDimChildren(dim, parent) {
  if (TREE_CHILDREN[dim][parent]) return TREE_CHILDREN[dim][parent];
  try {
    const r = await api('/meta/dims?dim=' + dim + '&parent=' + encodeURIComponent(parent));
    const list = (r.data || []).map(n => ({ code: n.code, name: n.name, isLeaf: !!n.isLeaf }));
    list.forEach(n => { DIM_NAMES[n.code] = n.name; });
    TREE_CHILDREN[dim][parent] = list;
  } catch (e) { TREE_CHILDREN[dim][parent] = []; }
  return TREE_CHILDREN[dim][parent];
}

/* ==================== 7. 路由与 URL 终态（§5） ==================== */

function parseHash() {
  const h = location.hash || '#/cockpit';
  const q = h.indexOf('?');
  const path = (q < 0 ? h : h.slice(0, q)).slice(1);
  const params = new URLSearchParams(q < 0 ? '' : h.slice(q + 1));
  let page = 'cockpit', themeId = 'macro';
  const m = path.match(/^\/theme\/(macro|tech)/);
  if (m) { page = 'theme'; themeId = m[1]; }
  else if (/^\/dict/.test(path)) page = 'dict';
  return { page, themeId, params };
}
/* 主题页终态 → hash（§5.2 参数表：r/rg/i/ig/cf/tf/gf.r/gf.i/m/dt） */
function themeHash(st) {
  const p = new URLSearchParams();
  if (st.r) p.set('r', st.r);
  if (st.rg) p.set('rg', st.rg);
  if (st.i) p.set('i', st.i);
  if (st.ig) p.set('ig', st.ig);
  const cfStr = Object.keys(st.cf).filter(d => st.cf[d] && st.cf[d].length)
    .map(d => d + ':' + st.cf[d].join('+')).join(';');
  if (cfStr) p.set('cf', cfStr);
  if (st.tf.join(',') !== DEFAULT_TF.join(',')) p.set('tf', st.tf.join(','));
  if (st.gfr) p.set('gf.r', st.gfr);
  if (st.gfi) p.set('gf.i', st.gfi);
  if (st.m) p.set('m', st.m);
  if (st.dt) p.set('dt', st.dt);
  const qs = p.toString();
  return '#/theme/' + st.domain + (qs ? '?' + qs : '');
}
function parseCf(str) {
  const out = {};
  if (!str) return out;
  String(str).split(';').forEach(part => {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1).split('+').filter(Boolean);
  });
  return out;
}
/* 参数 → 主题页终态（含 RLS 钳制：省身份下越权 r 清空并提示，D7/§5.4） */
function themeStateFromParams(themeId, P) {
  const st = {
    domain: themeId,
    r: P.get('r') || '', rg: P.get('rg') || '',
    i: P.get('i') || '', ig: P.get('ig') || '',
    cf: parseCf(P.get('cf')),
    tf: (P.get('tf') || DEFAULT_TF.join(',')).split(','),
    gfr: P.get('gf.r') || '', gfi: P.get('gf.i') || '',
    m: P.get('m') || '', dt: P.get('dt') || ''
  };
  if (st.tf.length !== 2 || !MONTHS.includes(st.tf[0]) || !MONTHS.includes(st.tf[1]) || st.tf[0] > st.tf[1]) st.tf = DEFAULT_TF.slice();
  if (ROLE !== 'leader') {
    const home = ROLE_HOME[ROLE].code;
    if (st.r && st.r !== home) { st.r = ''; st.rg = ''; setTimeout(() => toast('已按权限重置范围'), 0); }
  }
  if (st.r && !st.rg) st.rg = 'city';
  if (st.i && !st.ig) st.ig = 'c2';
  return st;
}
/* 状态迁移统一出口：pushState（后退=逐级上钻，D12）+ 重渲染 */
function go(hash, opts) {
  opts = opts || {};
  if (location.hash !== hash) {
    if (opts.replace) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
  }
  lastRenderedUrl = null;
  render();
}
function rerender() { lastRenderedUrl = null; render(); }

function render() {
  /* 未知 hash 重定向 #/cockpit（§5.1）；replaceState 仅用于初始规范化，不刷历史 */
  const h0 = (location.hash || '').split('?')[0];
  if (h0 !== '' && h0 !== '#/cockpit' && h0 !== '#/dict' && !/^#\/theme\/(macro|tech)$/.test(h0)) {
    history.replaceState(null, '', '#/cockpit');
  }
  const url = location.href;
  if (url === lastRenderedUrl) return;
  lastRenderedUrl = url;
  disposeAll();
  reqSeq++;
  closeCtxMenu();
  const route = parseHash();
  $$('#nav-tabs a').forEach(a => a.classList.toggle('active', a.dataset.nav === route.page));
  /* T29 导出报告按钮：驾驶舱/主题看板可见，指标字典页隐藏（页头常驻件） */
  const exBtn = $('#export-report-btn');
  if (exBtn) exBtn.style.display = route.page === 'dict' ? 'none' : '';
  const app = $('#app');
  curSt = null;
  if (route.page === 'theme') renderTheme(app, route.themeId, route.params);
  else if (route.page === 'dict') renderDict(app, route.params);
  else renderCockpit(app, route.params);   // T27：province/rg/metric 下钻参数入驾驶舱终态
}
window.addEventListener('popstate', render);
window.addEventListener('hashchange', render);

/* ==================== 8. 指标卡带（驾驶舱/主题共用） ==================== */

/* 迷你趋势 SVG（60×22，末点主色实心） */
function sparkSvg(vals) {
  if (!vals || vals.length < 2) return '';
  const w = 60, h = 22, pad = 1;
  const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  const span = (max - min) || 1;
  const pts = vals.map((v, i) => [pad + i * (w - 2 * pad) / (vals.length - 1), h - pad - (v - min) / span * (h - 2 * pad)]);
  const line = pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  return '<svg class="mcard-spark" width="' + w + '" height="' + h + '" aria-hidden="true">' +
    '<polyline class="spark-line" points="' + line + '"/>' +
    '<circle class="spark-dot" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="1.5"/></svg>';
}
function metricCardHtml(code, latest, series, opts) {
  const m = METAS[code] || { name: code, allowedCompares: ['yoy'] };
  const inverse = isInverse(m);
  const momOk = (m.allowedCompares || []).includes('mom');
  const tipParts = [code, '口径：' + (AGG_LABEL[m.aggType] || m.aggType), '比较：' + (CMP_LABEL[m.comparePolicy] || m.comparePolicy), '单位：' + (m.unit || '—')];
  if (inverse) tipParts.push('逆指标：数值上升为变差。口径见指标字典（#/dict?q=' + encodeURIComponent(code) + '）');
  const vals = (series || []).map(x => x.value).filter(v => v != null && !isNaN(v));
  const spark = (!opts.compact && vals.length >= 2) ? sparkSvg(vals) : '';
  return '<div class="mcard' + (inverse ? ' inverse' : '') + (opts.focus ? ' focus' : '') + '" data-href="' + esc(opts.href || '') + '" title="' + esc(tipParts.join('｜')) + '">' +
    '<div class="mcard-name" title="' + esc(m.name) + '">' + esc(m.name) + (inverse ? '<span class="tag-inverse">(逆)</span>' : '') + '</div>' +
    '<div class="mcard-val">' + (latest ? valFmt(m, latest.value) : '—') + '<span class="mcard-unit">' + esc(m.unit || '') + '</span></div>' +
    '<div class="mcard-cmp">' + cmpLineHtml(latest && latest.yoy, 'yoy', m) + (momOk ? cmpLineHtml(latest && latest.mom, 'mom', m) : '') + '</div>' +
    spark + '</div>';
}
function renderCardsInto(sel, codes, series, opts) {
  const el = $(sel); if (!el) return;
  opts = opts || {};
  setHtml(el, codes.map(code => {
    const arr = (series && series[code]) || [];
    const latest = arr.length ? arr[arr.length - 1] : null;
    const m = METAS[code] || {};
    const domain = m.domain || (code.indexOf('TECH.') === 0 ? 'tech' : 'macro');
    const href = '#/theme/' + domain + '?m=' + encodeURIComponent(code);
    return metricCardHtml(code, latest, arr, { compact: opts.compact, focus: opts.m === code, href });
  }).join(''));
}
/* 指标卡取数：按 allowedCompares 分组发 /query（避免 403，D4②/D16）；
 * 组内指标可能横跨区域行/行业行两个事实表族（如 CPI 消费 vs GDP 工业族）→ 服务端 400 DIM_MISMATCH，
 * 此时回退为逐指标单查（单指标必属单事实表），仍失败的指标（口径不支持当前过滤）跳过、卡面显示"—" */
async function fetchCardSeries(codes, range, filters) {
  const groups = {};
  codes.forEach(c => {
    const m = METAS[c]; if (!m) return;
    const key = (m.allowedCompares || ['yoy']).join(',');
    (groups[key] = groups[key] || []).push(c);
  });
  const out = {};
  const collect = (gcodes, res) => {
    harvestNames(res);
    (res.data || []).forEach(row => {
      const month = row.dims && row.dims.time ? row.dims.time.code : range[1];
      gcodes.forEach(c => {
        const mv = row.metrics && row.metrics[c]; if (!mv) return;
        (out[c] = out[c] || []).push({ month: month, value: mv.value, yoy: mv.yoy || null, mom: mv.mom || null });
      });
    });
  };
  const ask = async gcodes => {
    const compares = (METAS[gcodes[0]].allowedCompares || ['yoy']).slice();
    const body = {
      metrics: gcodes,
      dimensions: [{ dim: 'time', granularity: 'time_month' }],
      filters: (filters || []).slice(),
      time: { grain: 'month', range: [range[0], range[1]], compare: compares },
      limit: 1000
    };
    collect(gcodes, await api('/query', { method: 'POST', body }));
  };
  await Promise.all(Object.keys(groups).map(async key => {
    const gcodes = groups[key];
    try {
      await ask(gcodes);
    } catch (e) {
      if (e && e.code === 'DIM_MISMATCH') {
        await Promise.all(gcodes.map(async c => {
          try { await ask([c]); } catch (e2) { /* 口径与过滤不兼容（如 CPI 无行业维度）→ 该卡无值 */ }
        }));
      } else throw e;
    }
  }));
  Object.keys(out).forEach(c => out[c].sort((a, b) => (a.month < b.month ? -1 : 1)));
  return out;
}

/* ==================== 9. 领导驾驶舱 #/cockpit ==================== */

function renderCockpit(app, params) {
  const home = ROLE === 'leader' ? null : ROLE_HOME[ROLE];
  /* T27 地图下钻终态：#/cockpit?province=<adcode>&rg=city&metric=<code>（§4 图元契约） */
  const drill = {
    province: (params && params.get('province')) || '',
    rg: (params && params.get('rg')) || '',
    metric: (params && params.get('metric')) || ''
  };
  if (drill.province && drill.rg !== 'city') drill.rg = 'city';
  const drillName = drill.province ? (DIM_NAMES[drill.province] || drill.province) : '';
  setHtml(app,
    '<div class="page">' +
      '<div class="page-title-row"><h1>领导驾驶舱</h1>' +
        '<span class="sub">' + LATEST + ' · ' + (home ? home.name + '口径' : '全国口径') + '</span>' +
        (home ? '<span class="scope-chip">范围：' + esc(home.name) + '</span>' : '') +
        (drillName ? '<span class="scope-chip">下钻：' + esc(drillName) + '</span>' : '') +
      '</div>' +
      '<section class="mcards" id="cp-cards">' + sklMetricCards(COCKPIT_CARDS.length) + '</section>' +
      '<div class="cp-mid">' +
        '<section class="card chart-card" id="cp-trend">' + sklChartHtml() + '</section>' +
        '<section class="card chart-card" id="cp-rank">' + sklChartHtml() + '</section>' +
      '</div>' +
      '<div class="cp-bottom">' +
        '<section class="card alert-list">' +
          '<div class="alert-head"><h2>异常预警</h2><span class="alert-badge" id="cp-alert-badge"></span></div>' +
          '<div class="alert-rows" id="cp-alerts"></div>' +
        '</section>' +
        '<section class="cp-entries" id="cp-entries"></section>' +
      '</div>' +
    '</div>');
  const seq = reqSeq;
  loadCockpitCards(seq);
  loadCockpitTrend(seq);
  loadCockpitRank(seq, drill);
  renderCockpitAlerts();
  renderCockpitEntries();
}

async function loadCockpitCards(seq) {
  const key = 'cp-cards|' + ROLE;
  const el = '#cp-cards';
  try {
    let series = memo[key];
    if (!series) {
      series = await fetchCardSeries(COCKPIT_CARDS, [monthsBack(LATEST, 11), LATEST], []);
      if (seq !== reqSeq) return;
      memo[key] = series;
    }
    renderCardsInto(el, COCKPIT_CARDS, series, {});
  } catch (err) {
    if (seq !== reqSeq) return;
    setHtml($(el), errorBlock(err));
  }
}

/* B 区：GDP 当月值柱 + 累计同比增速线（[当月|累计] 分段切换，A-4） */
async function loadCockpitTrend(seq) {
  const el = $('#cp-trend'); if (!el) return;
  const home = ROLE === 'leader' ? null : ROLE_HOME[ROLE];
  const scope = home ? home.name : '全国';
  try {
    const res = await api('/query', {
      method: 'POST',
      body: {
        metrics: ['MACRO.GDP.VA0001', 'MACRO.GDP.GR0001'],
        dimensions: [{ dim: 'time', granularity: 'time_month' }],
        time: { grain: 'month', range: DEFAULT_TF, compare: ['yoy'] },
        limit: 1000
      }
    });
    if (seq !== reqSeq) return;
    harvestNames(res);
    const rows = (res.data || []).map(r => ({
      month: r.dims.time ? r.dims.time.code : '',
      va: r.metrics['MACRO.GDP.VA0001'] || {},
      gr: r.metrics['MACRO.GDP.GR0001'] || {}
    })).sort((a, b) => (a.month < b.month ? -1 : 1));
    if (!rows.length) {
      setHtml(el, chartShellHtml(scope + ' GDP 趋势', '', '', emptyBlock(emptyKind(res, false))));
      return;
    }
    const seg = '<div class="seg" id="cp-trend-seg"><button class="on" data-k="cur">当月</button><button data-k="cum">累计</button></div>';
    setHtml(el, chartShellHtml(scope + ' GDP 趋势', '当月值（柱，左轴）· 累计同比增速（线，右轴）', seg, '<div class="chart" id="cp-trend-chart"></div>'));
    let mode = 'cur';
    const draw = () => drawCockpitTrend(rows, mode);
    $('#cp-trend-seg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      mode = b.dataset.k;
      $$('#cp-trend-seg button').forEach(x => x.classList.toggle('on', x === b));
      draw();
    });
    draw();
  } catch (err) {
    if (seq !== reqSeq) return;
    setHtml(el, errorBlock(err));
  }
}
function drawCockpitTrend(rows, mode) {
  const el = $('#cp-trend-chart'); if (!el) return;
  const months = rows.map(r => r.month);
  let barData, barName, barArea = false;
  if (mode === 'cur') {
    barName = 'GDP 当月值（亿元）';
    barData = rows.map(r => r.va.value);
  } else {
    /* 累计模式：按年内部累加（本年累计值） */
    barName = 'GDP 本年累计值（亿元）';
    barData = []; let acc = 0, year = '';
    rows.forEach(r => {
      const y = r.month.slice(0, 4);
      if (y !== year) { acc = 0; year = y; }
      acc += (r.va.value || 0);
      barData.push(+acc.toFixed(1));
    });
    barArea = true;
  }
  const lineData = rows.map(r => (r.gr && r.gr.value != null ? r.gr.value : null));
  /* 工厂形态：语义色（主色柱/分类线）随主题现读 CSS 变量（T28 变量同步式） */
  mountChart(el, 'cp-trend', () => {
    const c = chrome();
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { top: 0, right: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, top: 30, bottom: 4, containLabel: true },
      xAxis: { type: 'category', data: months, axisLabel: { rotate: 35 } },
      yAxis: [
        { type: 'value', name: '亿元', scale: true },
        { type: 'value', name: '%', scale: true, splitLine: { show: false } }
      ],
      series: [
        { name: barName, type: 'bar', data: barData, barMaxWidth: 22, itemStyle: { color: c.primary, opacity: .85 }, areaStyle: barArea ? { opacity: .12 } : undefined },
        { name: '累计同比增速', type: 'line', yAxisIndex: 1, data: lineData, smooth: false, symbol: 'circle', symbolSize: 4, itemStyle: { color: c.cat[3] }, lineStyle: { width: 2 } }
      ]
    };
  });
}

/* C 区：省域地图（T27 图元契约 §4）——echarts.registerMap('china', GeoJSON) + series type 'map'
 * 替代原省域排名条形：数据源不变（同一 /api/v1/query DSL，grain=province × 当月同比），
 * 着色 = 当月同比分档：负增长红（--map-neg 系）/ 正增长蓝（--map-pos 系）/ 缺数灰（--map-none，港澳台等）；
 * 点击省份 → drill:nav 事件与原条形图完全同构（dim/value/toLevel/source 不变），
 * URL 终态协议一致：#/cockpit?province=320000&rg=city&metric=…（硬验收）；
 * 下钻态（省视角）：地图保持全国图 + 选中省 select 高亮 + visualMap 聚焦文案，市排名条形保留（下钻产物）；
 * GeoJSON 加载失败 → 卡片整体降级回原条形图（优雅降级，不许空白）；
 * 非 leader 身份（RLS 仅本省行）地图无意义 → 维持原所辖市排名条形 */
const MAP_NAME = 'china';
const RANK_METRIC = 'MACRO.GDP.GR0001';   // C 区排名口径（地图/条形/URL metric 参数三处同源）
let chinaGeoPromise = null;               // GeoJSON 懒加载缓存（569KB 本地资产，Promise 复用；失败允许重试）
function ensureChinaMap() {
  if (!chinaGeoPromise) {
    chinaGeoPromise = fetch('assets/geo/china.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(gj => { echarts.registerMap(MAP_NAME, gj); return gj; })
      .catch(e => { chinaGeoPromise = null; throw e; });
  }
  return chinaGeoPromise;
}
/* 当月同比 → 百分数值（rate 型 ×100；compare_then_compute 用 pct 点差 delta），供地图分档着色 */
function yoyPct(yoy) {
  if (!yoy) return null;
  const n = yoy.rate != null ? yoy.rate * 100 : yoy.delta;
  return (n == null || isNaN(n)) ? null : n;
}
/* 全称→简称兜底表（§4 buildNameMap：DataV 全称"江苏省/内蒙古自治区/香港特别行政区"
 * → 短名"江苏/内蒙古/香港"，地图标签防挤爆）。dims.json 节点含 name/short 双字段，
 * short 命中优先（loadDimRoots 采集进 DIM_SHORT）；未命中走后缀剥离兜底（民族/自治区/省/市/特别行政区） */
const DIM_SHORT = {};   // code -> 短名
const GEO_SUFFIX_RE = /特别行政区|维吾尔|壮族|回族|自治区|省|市/g;
function shortName(code, fullName) {
  if (code && DIM_SHORT[code]) return DIM_SHORT[code];
  return String(fullName || '').replace(GEO_SUFFIX_RE, '');
}
/* 省域行取数（与原条形图完全同一 DSL：region 粒度 × 当月双指标 × 同比，GR0001 降序） */
async function fetchRankRows(gran, filters) {
  const res = await api('/query', {
    method: 'POST',
    body: {
      metrics: ['MACRO.GDP.VA0001', RANK_METRIC],
      dimensions: [{ dim: 'region', granularity: gran }],
      filters: filters || [],
      time: { grain: 'month', range: [LATEST, LATEST], compare: ['yoy'] },
      sort: [{ by: RANK_METRIC, order: 'desc' }],
      limit: 50
    }
  });
  harvestNames(res);
  return (res.data || []).map(r => {
    const d = r.dims.region || {};
    return { code: d.code, name: d.name, gr: r.metrics[RANK_METRIC] || {}, va: r.metrics['MACRO.GDP.VA0001'] || {} };
  }).sort((a, b) => ((b.gr.value || -999) - (a.gr.value || -999)));
}
/* 地图下钻 URL 终态（§4：#/cockpit?province=320000&rg=city&metric=…） */
function cockpitDrillHash(province) {
  return '#/cockpit?province=' + encodeURIComponent(province) + '&rg=city&metric=' + encodeURIComponent(RANK_METRIC);
}

async function loadCockpitRank(seq, drill) {
  const leader = ROLE === 'leader';
  if (leader && drill.province) return loadCockpitMapDrilled(seq, drill);
  if (leader) return loadCockpitMap(seq);
  /* 非 leader：维持原条形（RLS 仅本省，全国地图无意义）；点击行为与原实现逐字一致 */
  return loadCockpitRankBar(seq, {
    leader: false, chartId: 'cp-rank',
    onPick: code => {
      bus.emit('drill:nav', { dim: 'region', value: code, toLevel: 'leaf', source: 'cockpit-rank' });
      drillFromCockpit(code, true);
    }
  });
}

/* —— 全国视角：省域地图卡片（leader） —— */
async function loadCockpitMap(seq) {
  const el = $('#cp-rank'); if (!el) return;
  let rows;
  try {
    rows = await fetchRankRows('province');
    if (seq !== reqSeq) return;
  } catch (err) {
    if (seq !== reqSeq) return;
    setHtml(el, errorBlock(err));   // 数据失败：条形图同样无米下锅，维持错误态（原行为），绝不空白
    return;
  }
  let geo;
  try {
    geo = await ensureChinaMap();
    if (seq !== reqSeq) return;
  } catch (e) {
    if (seq !== reqSeq) return;
    /* GeoJSON 加载失败 → 降级回原省域排名条形图（垫底标红逻辑保留） */
    return loadCockpitRankBar(seq, {
      leader: true, rows: rows, chartId: 'cp-rank', note: '地图资产加载失败，已降级为排名条形',
      onPick: code => {
        bus.emit('drill:nav', { dim: 'region', value: code, toLevel: 'city', source: 'cockpit-rank' });
        go(cockpitDrillHash(code));
      }
    });
  }
  setHtml(el, chartShellHtml('省域 GDP 当月同比地图',
    '负增长红 / 正增长蓝 / 缺数灰 · 单击省份下钻 · ' + LATEST, '',
    '<div class="chart" id="cp-rank-map"></div>'));
  drawCockpitMap(el.querySelector('#cp-rank-map'), 'cp-rank-map', geo, rows, '');
}

/* —— 下钻视角（省视角）：全国地图 + 选中省高亮 + 市排名条形（下钻产物，不删除） —— */
async function loadCockpitMapDrilled(seq, drill) {
  const el = $('#cp-rank'); if (!el) return;
  const provName = DIM_NAMES[drill.province] || drill.province;
  let geo;
  try {
    geo = await ensureChinaMap();
    if (seq !== reqSeq) return;
  } catch (e) {
    if (seq !== reqSeq) return;
    /* 下钻态 GeoJSON 失败 → 整卡降级为所辖市排名条形（原条形图） */
    return loadCockpitRankBar(seq, {
      leader: true, drilled: drill, chartId: 'cp-rank', note: '地图资产加载失败，已降级为所辖市排名条形',
      onPick: code => {
        bus.emit('drill:nav', { dim: 'region', value: code, toLevel: 'leaf', source: 'cockpit-rank' });
        go('#/theme/macro?r=' + encodeURIComponent(drill.province) + '&rg=city&dt=region:' + encodeURIComponent(code));
      }
    });
  }
  let rows = [], cityRows = [], cityErr = null;
  try {
    rows = await fetchRankRows('province');
    if (seq !== reqSeq) return;
  } catch (e) { rows = []; /* 着色数据失败 → 全图灰阶，不挡下钻态展示 */ }
  try {
    cityRows = await fetchRankRows('city', [{ dim: 'region', op: 'descendantOf', value: drill.province }]);
    if (seq !== reqSeq) return;
  } catch (e) {
    if (seq !== reqSeq) return;
    cityErr = e;
  }
  const back = '<button class="btn ghost" data-href="#/cockpit" title="返回全国总览">‹ 返回全国</button>';
  setHtml(el, chartShellHtml(esc(provName) + ' · 省域地图（全国视）',
    '选中省高亮 · 单击其他省可切换 · 下方市排名负增长标红 · ' + LATEST, back,
    '<div class="map-split"><div class="chart map-main" id="cp-rank-map"></div>' +
    '<div class="chart map-city" id="cp-rank-citybar"><div class="skl skl-chart"></div></div></div>'));
  drawCockpitMap(el.querySelector('#cp-rank-map'), 'cp-rank-map', geo, rows, drill.province);
  const cityHost = el.querySelector('#cp-rank-citybar');
  if (cityErr) { setHtml(cityHost, errorBlock(cityErr)); return; }
  loadCockpitRankBar(seq, {
    leader: true, drilled: drill, rows: cityRows, chartId: 'cp-rank-citybar', host: cityHost, standalone: false,
    onPick: code => {
      bus.emit('drill:nav', { dim: 'region', value: code, toLevel: 'leaf', source: 'cockpit-rank' });
      go('#/theme/macro?r=' + encodeURIComponent(drill.province) + '&rg=city&dt=region:' + encodeURIComponent(code));
    }
  });
}

/* —— 地图本体：registerMap 后的 series type 'map'（全国图；selectedCode 选中省高亮） —— */
function drawCockpitMap(container, id, geo, rows, selectedCode) {
  if (!container) return;
  const rowByCode = {};
  rows.forEach(r => { rowByCode[r.code] = r; DIM_NAMES[r.code] = r.name; });
  /* adcode 硬联结：GeoJSON properties.adcode 与 dims.json code 同构（比字符串映射稳）；
   * 全称名映射兜底（§4 buildNameMap：DataV 含省/直辖市/自治区/特别行政区后缀）；
   * 全称同时回填 DIM_NAMES（省码不在种子 5 省时，下钻面包屑/胶囊仍有可读全称） */
  const codeByName = {}, nameByCode = {};
  (geo.features || []).forEach(f => {
    const p = f.properties || {};
    const nm = p.name, ad = p.adcode != null ? String(p.adcode) : '';
    if (nm && /^\d{6}$/.test(ad)) {
      codeByName[nm] = ad; nameByCode[ad] = nm;
      if (!DIM_NAMES[ad]) DIM_NAMES[ad] = nm;
    }
  });
  /* 工厂形态 option（T28 变量同步式）：地图分档色/选中省描边/tooltip 皮肤等语义色
   * 每次挂载/主题重挂时现读 CSS 变量构造，暗色切换即时跟随 */
  mountChart(container, id, () => {
    const c = chrome();
    const mapData = [];
    Object.keys(nameByCode).forEach(code => {
      const r = rowByCode[code];
      const item = { name: nameByCode[code], code: code, value: r ? yoyPct(r.va.yoy) : null };
      if (selectedCode && code === selectedCode) {
        /* 选中省高亮（缺数省同样高亮，着灰不挡选中/点击）；标签用简称兜底表防挤爆 */
        item.itemStyle = {
          areaColor: r ? c.mapPosDeep : c.mapNone,
          borderColor: c.alert, borderWidth: 2,
          shadowBlur: 10, shadowColor: 'rgba(22,119,255,.55)'
        };
        item.label = {
          show: true, color: c.tooltipFg, fontSize: 11, fontWeight: 600,
          formatter: p => shortName(codeByName[p.name], p.name)
        };
      }
      mapData.push(item);
    });
    return {
      tooltip: {
        trigger: 'item',
        backgroundColor: c.tooltipBg,
        borderColor: c.tooltipBorder,
        textStyle: { color: c.tooltipFg },
        formatter: p => {
          const code = codeByName[p.name];
          const r = code ? rowByCode[code] : null;
          if (!r) return esc(p.name) + '<br/>暂无数据（缺数省，着灰；点击仍可下钻）';
          const yoyTxt = r.va.yoy ? cmpCellHtml(r.va.yoy) : '—';
          return esc(p.name) + '<br/>当月值：' + valFmt(METAS['MACRO.GDP.VA0001'], r.va.value) + ' 亿元' +
            '<br/>当月同比：' + yoyTxt +
            '<br/>累计同比：' + (r.gr.value != null ? r.gr.value.toFixed(2) + '%' : '—');
        }
      },
      visualMap: {
        type: 'piecewise', left: 8, bottom: 2, orient: 'horizontal',
        itemWidth: 14, itemHeight: 10, itemGap: 4,
        textStyle: { fontSize: 10, color: c.text3 },
        pieces: [
          { lt: -2, label: '负增长(深)', color: c.mapNegDeep },
          { gte: -2, lt: 0, label: '负增长', color: c.mapNeg },
          { gte: 0, lt: 2, label: '正增长', color: c.mapPos },
          { gte: 2, label: '正增长(强)', color: c.mapPosDeep }
        ]
      },
      series: [{
        type: 'map', map: MAP_NAME, roam: false, selectedMode: false,
        layoutCenter: ['50%', '52%'], layoutSize: '94%',   // 撑满卡片视口
        itemStyle: { areaColor: c.mapNone, borderColor: c.cardBg, borderWidth: 0.6 },
        emphasis: {
          label: {
            show: true, fontSize: 10, color: c.tooltipFg,
            formatter: p => shortName(codeByName[p.name], p.name)
          },
          itemStyle: { areaColor: c.mapHover }
        },
        data: mapData
      }]
    };
  }, [['click', p => {
    const code = codeByName[p.name]; if (!code) return;
    /* payload 与原条形图完全同构：leader 省份点击 → toLevel 'city'，source 溯源不变 */
    bus.emit('drill:nav', { dim: 'region', value: code, toLevel: 'city', source: 'cockpit-rank' });
    go(cockpitDrillHash(code));
  }]]);
}

/* —— 原省域/所辖市排名条形图（保留：非 leader 主视图、地图降级态、下钻市排名产物；
 *     垫底 3 标警逻辑原样保留） —— */
async function loadCockpitRankBar(seq, ctx) {
  const leader = !!ctx.leader;
  const drilled = ctx.drilled || null;
  const gran = (!leader || drilled) ? 'city' : 'province';
  const title = leader
    ? '省域 GDP 累计同比增速排名'
    : (drilled ? (DIM_NAMES[drilled.province] || drilled.province) + ' · 所辖市 GDP 累计同比增速排名' : '所辖市 GDP 累计同比增速排名');
  const sub = (ctx.note ? ctx.note + ' · ' : '') + '单击条形' + (leader && !drilled ? '下钻省份' : '查看该市明细') + ' · ' + LATEST;
  const host = ctx.host ? (ctx.host.nodeType ? ctx.host : $(ctx.host)) : $('#cp-rank');
  if (!host) return;
  const embed = ctx.standalone === false;   // 嵌入模式：host 为纯图表容器（下钻市排名），无卡片外壳
  const showEmpty = k => setHtml(host, embed ? emptyBlock(k) : chartShellHtml(title, '', '', emptyBlock(k)));
  let rows = ctx.rows || null;
  try {
    if (!rows) {
      const filters = drilled ? [{ dim: 'region', op: 'descendantOf', value: drilled.province }] : [];
      const res = await api('/query', {
        method: 'POST',
        body: {
          metrics: ['MACRO.GDP.VA0001', RANK_METRIC],
          dimensions: [{ dim: 'region', granularity: gran }],
          filters: filters,
          time: { grain: 'month', range: [LATEST, LATEST], compare: ['yoy'] },
          sort: [{ by: RANK_METRIC, order: 'desc' }],
          limit: 50
        }
      });
      if (seq !== reqSeq) return;
      harvestNames(res);
      rows = (res.data || []).map(r => {
        const d = r.dims.region || {};
        return { code: d.code, name: d.name, gr: r.metrics[RANK_METRIC] || {}, va: r.metrics['MACRO.GDP.VA0001'] || {} };
      }).sort((a, b) => ((b.gr.value || -999) - (a.gr.value || -999)));
      if (!rows.length) { showEmpty(emptyKind(res, !leader)); return; }
    }
  } catch (err) {
    if (seq !== reqSeq) return;
    setHtml(host, embed ? errorBlock(err) : errorBlock(err));
    return;
  }
  if (!rows.length) { showEmpty('no-data'); return; }
  if (embed) setHtml(host, '');   // 清骨架占位（宿主为纯图表容器）
  else setHtml(host, chartShellHtml(title, sub, '', '<div class="chart" id="' + ctx.chartId + '"></div>'));
  const nAlert = Math.min(3, rows.length);
  const alertFrom = rows.length - nAlert;   // 垫底标红（原逻辑）
  /* ECharts 类目轴自下而上，反转使第一名在顶部（names 与条形 data 同序） */
  const names = rows.map(r => r.name).reverse();
  const codeByName = {};
  rows.forEach(r => { codeByName[r.name] = r.code; });
  const mountEl = ctx.standalone === false ? host : host.querySelector('#' + ctx.chartId);
  if (!mountEl) return;
  /* 工厂形态 option：语义色随主题现读 CSS 变量（T28 变量同步式）
     着色规则：非独立模式（地图下钻的市排名，图例=红负/蓝正）→ 按数值符号着色；
     独立降级模式（GeoJSON 失败的省排名，无地图图例）→ 保留垫底标警旧逻辑 */
  mountChart(mountEl, ctx.chartId, () => {
    const c = chrome();
    const semantic = ctx.standalone === false;   // 地图伴随的市排名条形
    const data = rows.map((r, i) => {
      const neg = r.gr.value != null && r.gr.value < 0;
      const color = semantic ? (neg ? c.alert : c.primary)
        : (i >= alertFrom ? c.alert : c.primary);
      return {
        value: r.gr.value != null ? r.gr.value : null,
        name: r.name, code: r.code,
        rawYoy: r.va.yoy || r.gr.yoy || null,   // 供 tooltip 展示当月同比
        itemStyle: { color },
        label: { color: neg && semantic ? c.alert : c.text2 }
      };
    }).reverse();  // ECharts 类目轴自下而上，反转使第一名在顶部
    return {
      grid: { left: 8, right: 40, top: 8, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'item',
        formatter: p => {
          const d = data[p.dataIndex];
          const yoy = d && d.rawYoy;
          const yoyTxt = yoy ? cmpCellHtml(yoy) : '';
          return esc(p.name) + '<br/>累计同比增速：' + (p.value == null ? '—' : p.value.toFixed(2) + '%') + (yoyTxt ? '<br/>当月同比：' + yoyTxt : '');
        }
      },
      xAxis: { type: 'value', axisLabel: { formatter: '{value}%' } },
      yAxis: { type: 'category', data: names, axisLabel: { fontSize: 11 } },
      series: [{
        type: 'bar', data: data, barMaxWidth: 16,
        label: { show: true, position: 'right', fontSize: 11, formatter: p => (p.value == null ? '—' : p.value.toFixed(2) + '%') }
      }]
    };
  }, [['click', p => {
    const code = codeByName[p.name]; if (!code || !ctx.onPick) return;
    ctx.onPick(code);
  }]]);
  rows.forEach(r => { DIM_NAMES[r.code] = r.name; });
}
/* 驾驶舱是下钻发射台：省级 → 地图下钻终态（#/cockpit?province=…&rg=city）；
 * 市级（叶）→ 主题看板带明细抽屉终态（原逻辑；leader 无绑定省份时回全国口径） */
function drillFromCockpit(code, leaf) {
  if (leaf) {
    const home = ROLE_HOME[ROLE];
    if (!home) { go('#/theme/macro?dt=region:' + encodeURIComponent(code)); return; }
    go('#/theme/macro?r=' + encodeURIComponent(home.code) + '&rg=city&dt=region:' + encodeURIComponent(code));
  } else {
    go(cockpitDrillHash(code));   // J1 第 3 步终态（T27 起：驾驶舱内地图下钻）
  }
}

/* D 区：异常预警列表（契约 §1：优先 GET /api/v1/alerts 实时计算，X-Role 通道由 api() 统一携带；
 * 404/网络错误 → PRESET_ALERTS 预埋兜底渲染（优雅降级，旧后端不空）；
 * 行点击保持 data-href 与 C 区条形 drill:nav 同事件同终态（定位对应省主题看板 city 粒度），D12；
 * 卡头来源徽标：端点成功 → "实时计算 · computedAt"，失败 → "预埋兜底"） */
async function renderCockpitAlerts() {
  const el = $('#cp-alerts'); if (!el) return;
  const seq = reqSeq;
  const badge = () => $('#cp-alert-badge');
  const setBadge = (cls, text) => {
    const b = badge(); if (!b) return;
    b.className = 'alert-badge ' + cls;
    b.textContent = text;   // textContent 写入，天然免注入
  };
  /* 实时条目（契约字段）→ 行 HTML；level: danger→红 / warning→橙 */
  const liveRowHtml = (a, asof) => {
    const lv = a.level === 'danger' ? 'red' : 'orange';
    const region = a.region || a.province || '';
    const delta = (a.yoy == null ? '同比 —' : '同比 ' + fmtNum(a.yoy, 2) + 'pct') +
      (a.months != null ? ' · 连续 ' + a.months + ' 月' : '');
    return '<div class="alert-row lv-' + lv + '" data-href="#/theme/macro?r=' + encodeURIComponent(a.regionCode || '') + '&rg=city" title="定位到 ' + esc(region) + ' 主题看板">' +
      '<span class="chip ' + lv + '">' + (lv === 'red' ? '红色' : '橙色') + '</span>' +
      '<span class="alert-metric">' + esc(a.metricName || a.metricCode || '') + '</span>' +
      '<span class="alert-region">' + esc(region) + '</span>' +
      '<span class="alert-delta">' + esc(delta) + '</span>' +
      '<span class="alert-month">' + esc(asof || '') + '</span>' +
    '</div>';
  };
  /* 预埋兜底行（A1/A2/A3，旧文案不变） */
  const fallbackRowHtml = () => {
    const chipZh = { red: '红色', orange: '橙色', info: '提示' };
    return PRESET_ALERTS.map(a =>
      '<div class="alert-row lv-' + a.level + '" data-href="#/theme/macro?r=' + encodeURIComponent(a.regionCode) + '&rg=city" title="定位到 ' + esc(a.region) + ' 主题看板">' +
        '<span class="chip ' + a.level + '">' + chipZh[a.level] + '</span>' +
        '<span class="alert-metric">' + esc(a.metric) + '</span>' +
        '<span class="alert-region">' + esc(a.region) + '</span>' +
        '<span class="alert-delta">' + esc(a.delta) + '</span>' +
        '<span class="alert-month">' + esc(a.month) + '</span>' +
      '</div>'
    ).join('');
  };
  try {
    const res = await api('/alerts');   // 旧后端无此端点 → HTTP_404 走 catch
    if (seq !== reqSeq) return;
    const items = (res && res.items) || [];
    if (!items.length) throw { code: 'EMPTY_ALERTS', message: '端点返回空清单' };
    setBadge('live', '实时计算 · ' + String(res.computedAt || '').slice(0, 19).replace('T', ' '));
    setHtml(el, items.map(a => liveRowHtml(a, res.asof)).join(''));
  } catch (e) {
    if (seq !== reqSeq) return;
    setBadge('fallback', '预埋兜底');
    setHtml(el, fallbackRowHtml());
  }
}
/* E 区：主题速通入口 */
function renderCockpitEntries() {
  const el = $('#cp-entries'); if (!el) return;
  setHtml(el, ['macro', 'tech'].map(d => {
    const c = THEME_CONF[d];
    return '<div class="entry-card" data-href="#/theme/' + d + '">' +
      '<div class="entry-name">' + esc(c.title.replace('主题看板', '')) + '</div>' +
      '<p>' + esc(c.intro) + '</p></div>';
  }).join(''));
}

/* ==================== 10. 主题看板 #/theme/:id ==================== */

function renderTheme(app, themeId, params) {
  const st = themeStateFromParams(themeId, params);
  curSt = st; curThemeId = themeId;
  thTrendGran = 'industry_c1';
  const conf = THEME_CONF[themeId];
  setHtml(app,
    '<div class="page">' +
      '<div class="crumb-row">' +
        '<button class="icon-btn" id="dimtree-btn" title="维度树（下钻第三入口）">☰</button>' +
        '<div id="breadcrumb"></div>' +
        '<div class="pills" id="pills"></div>' +
      '</div>' +
      '<div class="gfilter-band" id="gfilter"></div>' +
      '<section class="mcards compact" id="th-cards">' + sklMetricCards(conf.cards.length, true) + '</section>' +
      '<div class="th-grid">' +
        '<section class="card chart-card" id="th-donut">' + sklChartHtml() + '</section>' +
        '<section class="card chart-card" id="th-trend">' + sklChartHtml() + '</section>' +
        '<section class="card chart-card" id="th-table">' + sklTableHtml() + '</section>' +
      '</div>' +
      '<div id="dimtree-wrap"></div>' +
      '<div id="drawer-wrap"></div>' +
    '</div>');
  renderBreadcrumb(st);
  renderPills(st);
  renderGFilter(st);
  const seq = reqSeq;
  loadThemeCards(seq, st, conf);
  loadDonut(seq, st, conf);
  loadTrendChart(seq, st, conf);
  loadRegionTable(seq, st, conf);
  if (st.dt) openDetailDrawer(st, conf);
  $('#dimtree-btn').addEventListener('click', () => toggleDimTree(st));
}

/* —— 面包屑（分维度栈；非末级可点上钻，§3.2） —— */
function renderBreadcrumb(st) {
  const el = $('#breadcrumb'); if (!el) return;
  const home = ROLE === 'leader' ? null : ROLE_HOME[ROLE];
  let html = '<span class="crumb-seg">';
  if (home) {
    html += '<span class="crumb-node cur">' + esc(home.name) + '</span>';
    if (st.r) html += '<span class="crumb-sep">›</span><span class="crumb-node cur">' + esc(DIM_NAMES[st.r] || st.r) + '</span>';
  } else {
    html += '<span class="crumb-node' + (st.r ? ' click' : ' cur') + '" data-drill="' + esc(JSON.stringify({ dim: 'region', value: '', toLevel: '' })) + '" title="回到全国">全国</span>';
    if (st.r) html += '<span class="crumb-sep">›</span><span class="crumb-node cur">' + esc(DIM_NAMES[st.r] || st.r) + '</span>';
  }
  html += '</span><span class="crumb-div">│</span><span class="crumb-seg">';
  html += '<span class="crumb-node' + (st.i ? ' click' : ' cur') + '" data-drill="' + esc(JSON.stringify({ dim: 'industry', value: '', toLevel: '' })) + '" title="回到全行业">全行业</span>';
  if (st.i) html += '<span class="crumb-sep">›</span><span class="crumb-node cur">' + esc(DIM_NAMES[st.i] || st.i) + '</span>';
  html += '</span>';
  setHtml(el, html);
}
/* 下钻/上钻统一状态迁移（drill:nav，三入口共用） */
function applyDrillNav(payload) {
  if (!curSt) return;
  bus.emit('drill:nav', payload);
  if (payload.dim === 'region') {
    if (payload.value) { curSt.r = payload.value; curSt.rg = payload.toLevel || 'city'; }
    else { curSt.r = ''; curSt.rg = ''; }
  } else if (payload.dim === 'industry') {
    if (payload.value) { curSt.i = payload.value; curSt.ig = payload.toLevel || 'c2'; }
    else { curSt.i = ''; curSt.ig = ''; }
  }
  go(themeHash(curSt));
}

/* —— 胶囊区（蓝=全局筛选 / 橙=联动 cross-filter；单个删 + 一键清除，§4.3） —— */
function renderPills(st) {
  const el = $('#pills'); if (!el) return;
  const pills = [];
  if (st.tf.join(',') !== DEFAULT_TF.join(',')) {
    pills.push('<span class="pill global">时间 ' + st.tf[0] + ' ~ ' + st.tf[1] + '<button class="pill-x" data-pill-kind="global" data-pill-dim="time" title="移除">×</button></span>');
  }
  if (st.gfr) pills.push('<span class="pill global">地区=' + esc(DIM_NAMES[st.gfr] || st.gfr) + '<button class="pill-x" data-pill-kind="global" data-pill-dim="region" title="移除">×</button></span>');
  if (st.gfi) pills.push('<span class="pill global">行业=' + esc(DIM_NAMES[st.gfi] || st.gfi) + '<button class="pill-x" data-pill-kind="global" data-pill-dim="industry" title="移除">×</button></span>');
  const crossDims = Object.keys(st.cf).filter(d => st.cf[d] && st.cf[d].length);
  crossDims.forEach(d => {
    const labels = st.cf[d].map(v => DIM_NAMES[v] || v).join('、');
    pills.push('<span class="pill cross">' + (d === 'industry' ? '行业' : d) + '=' + esc(labels) + '<button class="pill-x" data-pill-kind="cross" data-pill-dim="' + d + '" title="移除该联动">×</button></span>');
  });
  if (crossDims.length) pills.push('<button class="clear-linkage" data-clear-linkage title="清空全板联动（保留下钻栈）">清除联动</button>');
  setHtml(el, pills.join(''));
}

/* —— 全局筛选带（变更即清空联动，D15③；下钻栈保留） —— */
function renderGFilter(st) {
  const el = $('#gfilter'); if (!el) return;
  const regionOpts = ROLE === 'leader'
    ? DIM_ROOTS.region.map(n => '<option value="' + esc(n.code) + '"' + (st.gfr === n.code ? ' selected' : '') + '>' + esc(n.name) + '</option>')
    : (ROLE_HOME[ROLE] ? '<option value="' + ROLE_HOME[ROLE].code + '"' + (st.gfr === ROLE_HOME[ROLE].code ? ' selected' : '') + '>' + ROLE_HOME[ROLE].name + '</option>' : '');
  setHtml(el,
    '<label for="gf-time0">时间范围</label>' +
    '<input type="month" id="gf-time0" min="' + TIME_MIN + '" max="' + TIME_MAX + '" value="' + st.tf[0] + '"> ~ ' +
    '<input type="month" id="gf-time1" min="' + TIME_MIN + '" max="' + TIME_MAX + '" value="' + st.tf[1] + '">' +
    '<label for="gf-region">地区</label>' +
    '<select id="gf-region"><option value="">全部</option>' + regionOpts + '</select>' +
    '<label for="gf-industry">行业</label>' +
    '<select id="gf-industry"><option value="">全部</option>' +
      DIM_ROOTS.industry.map(n => '<option value="' + esc(n.code) + '"' + (st.gfi === n.code ? ' selected' : '') + '>' + esc(n.name) + '</option>').join('') +
    '</select>' +
    '<span style="color:var(--text-3)">变更全局筛选将清空全板联动</span>');
  const onChange = (dim, value) => {
    if (!curSt) return;
    bus.emit('global:change', { dim: dim, value: value, source: 'filter-band' });
    if (dim === 'time') {
      const a = $('#gf-time0').value || TIME_MIN, b = $('#gf-time1').value || TIME_MAX;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      curSt.tf = [MONTHS.includes(lo) ? lo : TIME_MIN, MONTHS.includes(hi) ? hi : TIME_MAX];
    } else if (dim === 'region') curSt.gfr = value;
    else curSt.gfi = value;
    curSt.cf = {};  // D15③：全局筛选变更 → 清空全部 cross-filter
    go(themeHash(curSt));
  };
  $('#gf-time0').addEventListener('change', e => onChange('time', e.target.value));
  $('#gf-time1').addEventListener('change', e => onChange('time', e.target.value));
  $('#gf-region').addEventListener('change', e => onChange('region', e.target.value));
  $('#gf-industry').addEventListener('change', e => onChange('industry', e.target.value));
}

/* —— 指标卡带（仅订阅全局筛选，不订阅联动，契约 §6.2-6） —— */
async function loadThemeCards(seq, st, conf) {
  const key = ['th-cards', ROLE, st.domain, st.tf.join(), st.gfr, st.gfi, conf.cards.join()].join('|');
  try {
    let series = memo[key];
    if (!series) {
      const filters = [];
      if (st.gfr) filters.push({ dim: 'region', op: 'descendantOf', value: st.gfr });
      if (st.gfi) filters.push({ dim: 'industry', op: 'in', values: [st.gfi] });
      series = await fetchCardSeries(conf.cards, st.tf, filters);
      if (seq !== reqSeq) return;
      memo[key] = series;
    }
    renderCardsInto('#th-cards', conf.cards, series, { compact: true, m: st.m });
  } catch (err) {
    if (seq !== reqSeq) return;
    setHtml($('#th-cards'), errorBlock(err));
  }
}

/* —— C1 行业构成环形图（联动源：扇区单击 filter:click，J1 第 4 步 / D14） —— */
async function loadDonut(seq, st, conf) {
  const el = $('#th-donut'); if (!el) return;
  const key = ['th-donut', ROLE, st.domain, st.tf.join(), st.gfr].join('|');
  try {
    let res = memo[key];
    if (!res) {
      const filters = [];
      if (st.gfr) filters.push({ dim: 'region', op: 'descendantOf', value: st.gfr });
      res = await api('/query', {
        method: 'POST',
        body: {
          metrics: [conf.main],
          dimensions: [{ dim: 'industry', granularity: 'industry_c1' }],
          filters: filters,
          time: { grain: 'month', range: [st.tf[1], st.tf[1]], compare: ['yoy'] },
          limit: 50
        }
      });
      if (seq !== reqSeq) return;
      memo[key] = res;
    }
    harvestNames(res);
    const m = METAS[conf.main] || {};
    const rows = (res.data || []).map(r => ({
      code: r.dims.industry ? r.dims.industry.code : '',
      name: r.dims.industry ? r.dims.industry.name : '',
      value: (r.metrics[conf.main] || {}).value,
      yoy: (r.metrics[conf.main] || {}).yoy || null
    })).filter(r => r.value != null);
    if (!rows.length) {
      setHtml(el, chartShellHtml('行业构成（门类）', '', '', emptyBlock(emptyKind(res, !!(st.gfr || st.cf.industry && st.cf.industry.length)))));
      return;
    }
    const total = rows.reduce((s, r) => s + (r.value || 0), 0);
    const baseSum = rows.reduce((s, r) => s + ((r.yoy && r.yoy.base) || 0), 0);
    const totalYoy = baseSum ? ((total - baseSum) / Math.abs(baseSum)) * 100 : null;
    const sel = (st.cf.industry || [])[0] || '';
    setHtml(el, chartShellHtml('行业构成（门类）', '单击扇区联动全板 · 圆心为' + esc(m.name || '') + '当期值', '',
      '<div class="chart" id="th-donut-chart"></div>'));
    /* 工厂形态 option：扇区分类色/选中描边/联动去饱和色/圆心数值色随主题现读 CSS 变量（T28 变量同步式） */
    mountChart(el.querySelector('#th-donut-chart'), 'th-donut', () => {
      const ch = chrome();
      const data = rows.map((r, i) => {
        const base = ch.cat[i % ch.cat.length];
        const isSel = !!sel && r.code === sel;
        const dimmed = !!sel && !isSel;
        return {
          value: r.value, name: r.name, code: r.code, yoy: r.yoy,
          itemStyle: isSel
            ? { color: base, borderColor: ch.primary, borderWidth: 2 }                     // 源扇区描边高亮 2px
            : (dimmed ? { color: desat(base, 0.4), opacity: 0.65 } : { color: base })      // 未命中：变暗35%+去饱和
        };
      });
      return {
        title: {
          text: valFmt(m, total), subtext: (totalYoy == null ? '同比 —' : '同比 ' + (totalYoy > 0 ? '▲' : totalYoy < 0 ? '▼' : '◇') + ' ' + Math.abs(totalYoy).toFixed(1) + '%'),
          left: 'center', top: '40%',
          textStyle: { fontSize: 20, fontWeight: 600, color: ch.text1, fontFamily: FONT_STACK },
          subtextStyle: { fontSize: 11, color: totalYoy == null ? ch.flat : (totalYoy > 0 ? ch.up : totalYoy < 0 ? ch.down : ch.flat) }
        },
        tooltip: {
          trigger: 'item',
          formatter: p => {
            const d = p.data;
            const pct = total ? (p.value / total * 100).toFixed(1) : '0';
            const yoyTxt = d.yoy && d.yoy.base != null ? '<br/>同比：' + cmpCellHtml(d.yoy) : '';
            return esc(p.name) + '<br/>' + esc(m.name || '') + '：' + valFmt(m, p.value) + (m.unit ? ' ' + esc(m.unit) : '') + '<br/>占比：' + pct + '%' + yoyTxt;
          }
        },
        legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 } },
        series: [{
          type: 'pie', radius: ['42%', '66%'], center: ['50%', '44%'],
          data: data, avoidLabelOverlap: true,
          itemStyle: { borderColor: ch.cardBg, borderWidth: 1 },
          /* 长门类名（如"信息传输、软件和信息技术服务业"）截为 6 字短名：避免标签被画布边缘裁剪；全名见图例/悬停 */
          label: {
            fontSize: 11, width: 64, overflow: 'truncate',
            formatter: p => (p.name.length > 6 ? p.name.slice(0, 6) + '…' : p.name) + '\n' + p.percent.toFixed(1) + '%'
          }
        }]
      };
    }, [
      ['click', p => {
        const code = p.data && p.data.code; if (!code) return;
        onDonutSectorClick(code);
      }],
      ['contextmenu', p => {
        const code = p.data && p.data.code;
        if (code) openDetailByCode('industry', code);
      }]
    ]);
  } catch (err) {
    if (seq !== reqSeq) return;
    setHtml(el, errorBlock(err));
  }
}
/* 扇区单击 → 总线广播 filter:click（再点选中扇区=清除该维度联动，D14/D15） */
function onDonutSectorClick(code) {
  if (!curSt) return;
  const cur = (curSt.cf.industry || [])[0];
  const values = cur === code ? [] : [code];   // 同维度 last-wins
  bus.emit('filter:click', { dim: 'industry', values: values, op: 'in', source: 'c1-industry-donut' });
  if (values.length) curSt.cf.industry = values;
  else delete curSt.cf.industry;
  go(themeHash(curSt));
}

/* —— C2 大类趋势柱线图（订阅联动：cross-filter 带 sourceChartId 重查 + 漏斗角标） —— */
async function loadTrendChart(seq, st, conf) {
  const el = $('#th-trend'); if (!el) return;
  const gran = st.i ? 'industry_c2' : thTrendGran;   // 下钻到门类后本图落到大类
  const granZh = gran === 'industry_c1' ? '门类' : '大类';
  const m = METAS[conf.main] || {};
  const filters = [];
  if (st.i) filters.push({ dim: 'industry', op: 'descendantOf', value: st.i });
  if (st.gfi) filters.push({ dim: 'industry', op: 'in', values: [st.gfi] });
  const crossVals = st.cf.industry || [];
  const crossActive = crossVals.length > 0;
  if (crossActive) filters.push({ dim: 'industry', op: 'in', values: crossVals, sourceChartId: 'c1-industry-donut' });
  try {
    const res = await api('/query', {
      method: 'POST',
      body: {
        metrics: [conf.main],
        dimensions: [{ dim: 'industry', granularity: gran }, { dim: 'time', granularity: 'time_month' }],
        filters: filters,
        time: { grain: 'month', range: [st.tf[0], st.tf[1]], compare: ['yoy'] },
        limit: 1000
      }
    });
    if (seq !== reqSeq) return;
    harvestNames(res);
    const hasCtx = crossActive || !!st.i || !!st.gfi;
    if (!(res.data || []).length) {
      setHtml(el, chartShellHtml(granZh + '趋势', '', '', emptyBlock(emptyKind(res, hasCtx)), crossActive ? '行业构成图' : ''));
      return;
    }
    /* 汇聚为 月份 × 类目 矩阵 */
    const byMonth = {};
    (res.data || []).forEach(r => {
      const mm = r.dims.time ? r.dims.time.code : '';
      const ind = r.dims.industry || {};
      const mv = r.metrics[conf.main] || {};
      if (!mm || !ind.code) return;
      byMonth[mm] = byMonth[mm] || [];
      byMonth[mm].push({ code: ind.code, name: ind.name, value: mv.value, base: mv.yoy ? mv.yoy.base : null });
    });
    let months = Object.keys(byMonth).sort().slice(-12);   // 近 12 个月
    const catSet = {};
    months.forEach(mm => byMonth[mm].forEach(x => { catSet[x.code] = x.name; }));
    const cats = Object.keys(catSet).sort((a, b) => {
      const va = (byMonth[months[months.length - 1]] || []).find(x => x.code === a);
      const vb = (byMonth[months[months.length - 1]] || []).find(x => x.code === b);
      return ((vb && vb.value) || 0) - ((va && va.value) || 0);
    });
    /* 合计同比线数据（右轴）：Σvalue 对 Σbase（数值与主题无关，工厂外预算） */
    const lineData = months.map(mm => {
      const rowsM = byMonth[mm] || [];
      const v = rowsM.reduce((s, x) => s + (x.value || 0), 0);
      const b = rowsM.reduce((s, x) => s + (x.base != null ? x.base : 0), 0);
      const hasBase = rowsM.some(x => x.base != null);
      if (!hasBase || !b) return null;
      return +(((v - b) / Math.abs(b)) * 100).toFixed(2);
    });
    const seg = st.i ? '' :
      '<div class="seg" id="th-trend-seg"><button class="' + (gran === 'industry_c1' ? 'on' : '') + '" data-k="industry_c1">门类</button><button class="' + (gran === 'industry_c2' ? 'on' : '') + '" data-k="industry_c2">大类</button></div>';
    setHtml(el, chartShellHtml(
      (st.i ? (DIM_NAMES[st.i] || st.i) + '·' : '') + granZh + '趋势',
      '柱：' + esc(m.name || '') + '月值（近 12 月，堆叠）｜线：合计同比（右轴）',
      seg,
      '<div class="chart" id="th-trend-chart"></div>',
      crossActive ? '行业构成图' : ''
    ));
    const codeByName = catSet;
    /* 工厂形态 option：堆叠分类色/合计线色随主题现读 CSS 变量（T28 变量同步式） */
    mountChart(el.querySelector('#th-trend-chart'), 'th-trend', () => {
      const series = cats.map((code, i) => ({
        name: catSet[code], type: 'bar', stack: 'total', barMaxWidth: 26,
        itemStyle: { color: chrome().cat[i % chrome().cat.length] },
        data: months.map(mm => {
          const hit = (byMonth[mm] || []).find(x => x.code === code);
          return hit ? hit.value : 0;
        })
      }));
      series.push({
        name: '合计同比', type: 'line', yAxisIndex: 1, symbol: 'circle', symbolSize: 4,
        itemStyle: { color: chrome().cat[3] }, lineStyle: { width: 2 },
        data: lineData
      });
      return {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: { top: 0, right: 0, type: 'scroll', textStyle: { fontSize: 11 } },
        grid: { left: 8, right: 8, top: 30, bottom: 4, containLabel: true },
        xAxis: { type: 'category', data: months, axisLabel: { rotate: 35 } },
        yAxis: [{ type: 'value', name: m.unit || '', scale: true }, { type: 'value', name: '%', scale: true, splitLine: { show: false } }],
        series: series
      };
    }, [
      ['click', p => {
        if (p.componentType !== 'series' || p.seriesType !== 'bar') return;
        const code = Object.keys(codeByName).find(k => codeByName[k] === p.seriesName);
        if (!code) return;
        if (gran === 'industry_c1') {
          applyDrillNav({ dim: 'industry', value: code, toLevel: 'c2', source: 'c2-cat-trend' });  // 门类 → 大类下钻
        } else {
          openDetailByCode('industry', code);   // 大类为叶子 → 查看明细
        }
      }],
      ['contextmenu', p => {
        const code = Object.keys(codeByName).find(k => codeByName[k] === p.seriesName);
        if (code) openDetailByCode('industry', code);
      }]
    ]);
    if (!st.i) {
      const segEl = $('#th-trend-seg');
      if (segEl) segEl.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        thTrendGran = b.dataset.k;   // 本图私有粒度，不写回全局
        loadTrendChart(reqSeq, curSt, THEME_CONF[curThemeId]);
      });
    }
  } catch (err) {
    if (seq !== reqSeq) return;
    setHtml(el, errorBlock(err));
  }
}

/* —— C3 省市明细表（订阅联动 + 下钻栈；行点击下钻 / 右键明细，§4.6） —— */
async function loadRegionTable(seq, st, conf) {
  const el = $('#th-table'); if (!el) return;
  const m = METAS[conf.main] || {};
  const cmpAllows = m.allowedCompares || ['yoy'];
  const compares = ['yoy', 'mom'].filter(c => cmpAllows.includes(c));
  const drilled = !!st.r;
  const gran = (drilled || st.gfr || ROLE !== 'leader') ? 'city' : 'province';
  const filters = [];
  if (st.r) filters.push({ dim: 'region', op: 'descendantOf', value: st.r });
  else if (st.gfr) filters.push({ dim: 'region', op: 'descendantOf', value: st.gfr });
  if (st.gfi) filters.push({ dim: 'industry', op: 'in', values: [st.gfi] });
  const crossVals = st.cf.industry || [];
  const crossActive = crossVals.length > 0;
  if (crossActive) filters.push({ dim: 'industry', op: 'in', values: crossVals, sourceChartId: 'c1-industry-donut' });
  try {
    const res = await api('/query', {
      method: 'POST',
      body: {
        metrics: [conf.main],
        dimensions: [{ dim: 'region', granularity: gran }],
        filters: filters,
        time: { grain: 'month', range: [st.tf[1], st.tf[1]], compare: compares },
        sort: [{ by: conf.main, order: 'desc' }],
        limit: 50
      }
    });
    if (seq !== reqSeq) return;
    harvestNames(res);
    const hasCtx = crossActive || drilled || !!st.gfi || !!st.gfr;
    const title = drilled ? (DIM_NAMES[st.r] || st.r) + '所辖市明细' : (gran === 'city' ? '所辖市明细' : '省域明细');
    if (!(res.data || []).length) {
      setHtml(el, chartShellHtml(title, '', '', emptyBlock(emptyKind(res, hasCtx)), crossActive ? '行业构成图' : ''));
      return;
    }
    const rows = (res.data || []).map(r => ({
      code: r.dims.region ? r.dims.region.code : '',
      name: r.dims.region ? r.dims.region.name : '',
      mv: r.metrics[conf.main] || {}
    }));
    const drillable = gran === 'province';   // 省行可继续下钻到市；市为叶子
    const body = rows.map(r => {
      const yoy = r.mv.yoy || null;
      const neg = yoy && ((yoy.rate != null ? yoy.rate < 0 : yoy.delta < 0));
      const attrs = drillable
        ? ' data-drill="' + esc(JSON.stringify({ dim: 'region', value: r.code, toLevel: 'city' })) + '"'
        : ' data-detail="region:' + esc(r.code) + '"';
      return '<tr class="row-click' + (neg ? ' alert-row' : '') + '"' + attrs + ' data-ctx="' + esc(JSON.stringify({ dim: 'region', code: r.code, name: r.name })) + '">' +
        '<td>' + esc(r.name) + '</td>' +
        '<td class="num">' + valFmt(m, r.mv.value) + '</td>' +
        '<td class="num">' + (yoy ? cmpCellHtml(yoy) : '—') + '</td>' +
        (compares.includes('mom') ? '<td class="num">' + (r.mv.mom ? cmpCellHtml(r.mv.mom) : '—') + '</td>' : '') +
        '</tr>';
    }).join('');
    setHtml(el, chartShellHtml(title,
      '行点击' + (drillable ? '下钻所辖市' : '查看明细') + ' · 右键查看逐月明细 · ' + st.tf[1],
      '',
      '<div class="dtable-wrap"><div class="dtable-scroll"><table class="dtable"><thead><tr>' +
        '<th>地区</th><th class="num">' + esc(m.name || '') + (m.unit ? '（' + esc(m.unit) + '）' : '') + '</th><th class="num">同比</th>' +
        (compares.includes('mom') ? '<th class="num">环比</th>' : '') +
        '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="tfoot-note">' + esc(conf.main) + ' · ' + esc(AGG_LABEL[m.aggType] || m.aggType || '') + ' · ' + esc(CMP_LABEL[m.comparePolicy] || m.comparePolicy || '') + ' · 责任处室：' + esc(m.ownerDept || '—') + '</div></div>',
      crossActive ? '行业构成图' : ''
    ));
  } catch (err) {
    if (seq !== reqSeq) return;
    setHtml(el, errorBlock(err));
  }
}

/* —— 明细抽屉（drill-to-detail，§3.7：dt=dim:code 入 URL） —— */
function drawerClose(st) {
  st.dt = '';
  go(themeHash(st));
}
function openDetailByCode(dim, code) {
  if (!curSt) return;
  bus.emit('drill:detail', { dim: dim, value: code, metric: THEME_CONF[curThemeId].main, source: 'page' });
  curSt.dt = dim + ':' + code;
  go(themeHash(curSt));
}
function openDetailDrawer(st, conf) {
  const wrap = $('#drawer-wrap'); if (!wrap) return;
  const i = st.dt.indexOf(':');
  if (i < 0) { wrap.innerHTML = ''; return; }
  const dim = st.dt.slice(0, i), code = st.dt.slice(i + 1);
  const dimZh = dim === 'region' ? '地区' : '行业';
  setHtml(wrap,
    '<div class="mask" id="drawer-mask"></div>' +
    '<aside class="drawer" role="dialog" aria-label="逐月明细">' +
      '<div class="drawer-head"><h3>' + dimZh + '逐月明细 · ' + esc(DIM_NAMES[code] || code) + '</h3>' +
      '<button class="icon-btn" id="drawer-close" title="关闭（Esc）">✕</button></div>' +
      '<div class="drawer-body" id="drawer-body">' + sklTableHtml() + '</div>' +
    '</aside>');
  $('#drawer-close').addEventListener('click', () => drawerClose(st));
  $('#drawer-mask').addEventListener('click', () => drawerClose(st));
  const seq = reqSeq;
  (async () => {
    const body = $('#drawer-body'); if (!body) return;
    const m = METAS[conf.main] || {};
    const cmpAllows = m.allowedCompares || ['yoy'];
    const compares = ['yoy', 'mom'].filter(c => cmpAllows.includes(c));
    try {
      const res = await api('/query', {
        method: 'POST',
        body: {
          metrics: [conf.main],
          dimensions: [{ dim: 'time', granularity: 'time_month' }],
          filters: [{ dim: dim, op: 'in', values: [code] }],
          time: { grain: 'month', range: [st.tf[0], st.tf[1]], compare: compares },
          limit: 100
        }
      });
      if (seq !== reqSeq) return;
      const rows = (res.data || []).map(r => ({
        month: r.dims.time ? r.dims.time.code : '',
        mv: r.metrics[conf.main] || {}
      })).sort((a, b) => (a.month < b.month ? -1 : 1));
      const trs = rows.map(r => {
        const yoy = r.mv.yoy || null;
        const neg = yoy && ((yoy.rate != null ? yoy.rate < 0 : yoy.delta < 0));
        return '<tr' + (neg ? ' class="alert-row"' : '') + '>' +
          '<td>' + esc(r.month) + '</td>' +
          '<td class="num">' + valFmt(m, r.mv.value) + '</td>' +
          '<td class="num">' + (yoy ? cmpCellHtml(yoy) : '—') + '</td>' +
          (compares.includes('mom') ? '<td class="num">' + (r.mv.mom ? cmpCellHtml(r.mv.mom) : '—') + '</td>' : '') +
          '</tr>';
      }).join('');
      setHtml(body, '<table class="dtable"><thead><tr><th>月份</th><th class="num">' + esc(m.name || '') + '</th><th class="num">同比</th>' +
        (compares.includes('mom') ? '<th class="num">环比</th>' : '') + '</tr></thead><tbody>' + trs + '</tbody></table>' +
        '<div class="tfoot-note">' + esc(conf.main) + ' · ' + esc(AGG_LABEL[m.aggType] || '') + ' · ' + esc(CMP_LABEL[m.comparePolicy] || '') + ' · 责任处室：' + esc(m.ownerDept || '—') + '</div>');
    } catch (err) {
      if (seq !== reqSeq) return;
      setHtml(body, errorBlock(err));
    }
  })();
}

/* —— 维度树侧栏（第三下钻入口，§4.7；prov-* 仅本省子树由服务端裁剪） —— */
let dimTreeOpen = false;
async function toggleDimTree(st) {
  dimTreeOpen = !dimTreeOpen;
  const wrap = $('#dimtree-wrap'); if (!wrap) return;
  if (!dimTreeOpen) { wrap.innerHTML = ''; return; }
  setHtml(wrap, '<div class="mask" id="dimtree-mask"></div><aside class="dimtree" id="dimtree-panel"></aside>');
  $('#dimtree-mask').addEventListener('click', () => { dimTreeOpen = false; wrap.innerHTML = ''; });
  await renderDimTreePanel(st);
}
async function renderDimTreePanel(st) {
  const panel = $('#dimtree-panel'); if (!panel) return;
  const home = ROLE === 'leader' ? null : ROLE_HOME[ROLE];
  const nodeHtml = (dim, n, cur, leaf) =>
    '<div class="tree-node' + (cur ? ' cur' : '') + '" data-tree="' + esc(JSON.stringify({ dim: dim, code: n.code, leaf: !!leaf })) + '">' +
      (!leaf ? '<button class="tree-toggle" data-tree-toggle="' + esc(dim + ':' + n.code) + '">▸</button>' : '<span style="width:16px"></span>') +
      esc(n.name) + '</div>';
  let regionHtml = '';
  if (home) {
    regionHtml = nodeHtml('region', { code: home.code, name: home.name }, !st.r, false);
    if (st.r) {
      const kids = await loadDimChildren('region', home.code);
      regionHtml += '<div class="tree-children">' + kids.map(k => nodeHtml('region', k, st.r === k.code, k.isLeaf)).join('') + '</div>';
    }
  } else {
    regionHtml = nodeHtml('region', { code: '', name: '全国' }, !st.r, false);
    const provs = DIM_ROOTS.region;
    let inner = '';
    if (st.r) {
      const kids = await loadDimChildren('region', st.r);
      inner = kids.map(k => nodeHtml('region', k, true, k.isLeaf)).join('');
    }
    regionHtml += '<div class="tree-children">' + provs.map(p =>
      nodeHtml('region', p, !!st.r && st.r === p.code, false) +
      (st.r === p.code && inner ? '<div class="tree-children">' + inner + '</div>' : '')
    ).join('') + '</div>';
  }
  let industryHtml = nodeHtml('industry', { code: '', name: '全行业' }, !st.i, false);
  {
    let inner = '';
    if (st.i) {
      const kids = await loadDimChildren('industry', st.i);
      inner = kids.map(k => nodeHtml('industry', k, true, k.isLeaf)).join('');
    }
    industryHtml += '<div class="tree-children">' + DIM_ROOTS.industry.map(p =>
      nodeHtml('industry', p, !!st.i && st.i === p.code, false) +
      (st.i === p.code && inner ? '<div class="tree-children">' + inner + '</div>' : '')
    ).join('') + '</div>';
  }
  setHtml(panel, '<div class="tree-group"><h4>地区维度</h4>' + regionHtml + '</div><div class="tree-group"><h4>行业维度</h4>' + industryHtml + '</div>');
}

/* ==================== 11. 指标字典 #/dict ==================== */

function filterDictList(q) {
  const kw = (q || '').trim().toLowerCase();
  return META_LIST.filter(m => {
    if (DICT_FACETS.domain && m.domain !== DICT_FACETS.domain) return false;
    if (DICT_FACETS.agg && m.aggType !== DICT_FACETS.agg) return false;
    if (DICT_FACETS.cmp && m.comparePolicy !== DICT_FACETS.cmp) return false;
    if (DICT_FACETS.pol && m.polarity !== DICT_FACETS.pol) return false;
    if (!kw) return true;
    return (m.name || '').toLowerCase().includes(kw) || (m.code || '').toLowerCase().includes(kw) || (m.ownerDept || '').toLowerCase().includes(kw);
  });
}
function dictTableHtml(list, sel) {
  const rows = list.map(m => {
    const inverse = isInverse(m);
    return '<tr class="row-click' + (sel === m.code ? ' sel' : '') + '" data-sel="' + esc(m.code) + '">' +
      '<td class="code-cell">' + esc(m.code) + '</td>' +
      '<td>' + esc(m.name) + '</td>' +
      '<td>' + (m.domain === 'macro' ? '宏观' : '科技') + '</td>' +
      '<td>' + esc(m.unit) + '</td>' +
      '<td><span class="badge">' + esc(AGG_LABEL[m.aggType] || m.aggType) + '</span></td>' +
      '<td><span class="badge blue">' + esc(CMP_LABEL[m.comparePolicy] || m.comparePolicy) + '</span></td>' +
      '<td>' + (inverse ? '<span class="badge inv">逆</span>' : '<span class="badge pos">正</span>') + '</td>' +
      '</tr>';
  }).join('');
  if (!list.length) return '<div class="state-block"><div class="empty-ic">' + ICON_DOC + '</div><div class="state-txt">未找到匹配指标</div><div class="state-sub">尝试更换关键词或清除侧栏筛选</div></div>';
  return '<div class="dtable-scroll" style="max-height:calc(100vh - 220px)"><table class="dtable"><thead><tr>' +
    '<th>编码</th><th>名称</th><th>主题</th><th>单位</th><th>agg_type</th><th>compare_policy</th><th>polarity</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}
function dictDetailHtml(m) {
  if (!m) return '<div class="state-block"><div class="empty-ic">' + ICON_DOC + '</div><div class="state-txt">点击左侧列表选择指标</div></div>';
  const inverse = isInverse(m);
  return '<h2>' + esc(m.name) + '</h2><div class="d-code">' + esc(m.code) + '</div>' +
    '<div>' +
      '<span class="badge blue">' + esc(AGG_LABEL[m.aggType] || m.aggType) + '</span> ' +
      '<span class="badge blue">' + esc(CMP_LABEL[m.comparePolicy] || m.comparePolicy) + '</span> ' +
      '<span class="badge ' + (inverse ? 'inv' : 'pos') + '">' + (inverse ? '逆' : '正') + '</span> ' +
      '<span class="badge">单位：' + esc(m.unit || '—') + '</span> ' +
      '<span class="badge">' + esc(FREQ_LABEL[m.updateFreq] || m.updateFreq) + '</span>' +
    '</div>' +
    '<dl>' +
      '<dt>口径公式</dt><dd><div class="formula">' + esc(m.formula || '—') + '</div></dd>' +
      (m.numeratorRef ? '<dt>分子</dt><dd class="code-cell">' + esc(m.numeratorRef) + '</dd>' : '') +
      (m.denominatorRef ? '<dt>分母</dt><dd class="code-cell">' + esc(m.denominatorRef) + '</dd>' : '') +
      '<dt>口径依据</dt><dd>' + esc(m.basisDocNo || '—') + '</dd>' +
      '<dt>责任处室</dt><dd>' + esc(m.ownerDept || '—') + '</dd>' +
      '<dt>更新频率</dt><dd>' + esc(FREQ_LABEL[m.updateFreq] || m.updateFreq || '—') + '</dd>' +
      '<dt>数据分级</dt><dd>' + esc(m.dataClass || 'general') + '</dd>' +
      '<dt>允许比较</dt><dd>' + ((m.allowedCompares || []).map(c => c === 'yoy' ? '同比' : '环比').join('、') || '—') + ((m.allowedCompares || []).includes('mom') ? '' : '（禁环比，入口不渲染）') + '</dd>' +
    '</dl>' +
    (inverse ? '<div class="pol-note">逆指标：数值上升为变差（展示时按警示语义，"较上年上升 X pct"）。</div>' : '') +
    '<div style="margin-top:12px"><button class="btn" data-href="#/theme/' + esc(m.domain) + '?m=' + encodeURIComponent(m.code) + '">在看板中查看</button></div>';
}
function renderDict(app, params) {
  let q = params.get('q') || '';
  let sel = params.get('sel') || '';
  const facet = (group, key, label, value) =>
    '<label><input type="radio" name="facet-' + group + '" value="' + esc(key) + '"' + (value === key ? ' checked' : '') + '> ' + label + '</label>';
  setHtml(app,
    '<div class="page">' +
      '<div class="dict-search">' +
        '<input id="dict-q" type="text" placeholder="搜索指标名称 / 编码 / 责任处室" value="' + esc(q) + '" autocomplete="off">' +
        '<span class="dict-count" id="dict-count"></span>' +
      '</div>' +
      '<div class="dict-layout">' +
        '<aside class="facet-side">' +
          '<div class="facet-group"><h3>主题域</h3>' +
            facet('domain', '', '全部', DICT_FACETS.domain) + facet('domain', 'macro', '宏观', DICT_FACETS.domain) + facet('domain', 'tech', '科技', DICT_FACETS.domain) + '</div>' +
          '<div class="facet-group"><h3>agg_type</h3>' +
            facet('agg', '', '全部', DICT_FACETS.agg) + facet('agg', 'sum', '求和', DICT_FACETS.agg) + facet('agg', 'ratio', '比值', DICT_FACETS.agg) + facet('agg', 'cumulative', '累计', DICT_FACETS.agg) + facet('agg', 'snapshot', '快照', DICT_FACETS.agg) + '</div>' +
          '<div class="facet-group"><h3>compare_policy</h3>' +
            facet('cmp', '', '全部', DICT_FACETS.cmp) + facet('cmp', 'direct', '直接比较', DICT_FACETS.cmp) + facet('cmp', 'compare_then_compute', '先比后算', DICT_FACETS.cmp) + facet('cmp', 'cumulative', '累计同比', DICT_FACETS.cmp) + facet('cmp', 'snapshot', '快照同比', DICT_FACETS.cmp) + '</div>' +
          '<div class="facet-group"><h3>polarity</h3>' +
            facet('pol', '', '全部', DICT_FACETS.pol) + facet('pol', 'positive', '正指标', DICT_FACETS.pol) + facet('pol', 'inverse', '逆指标', DICT_FACETS.pol) + '</div>' +
        '</aside>' +
        '<section class="card" style="padding:12px;min-width:0" id="dict-list"></section>' +
        '<aside class="dict-detail" id="dict-detail"></aside>' +
      '</div>' +
    '</div>');
  const inp = $('#dict-q');
  const update = () => {
    const list = filterDictList(q);
    setHtml($('#dict-list'), dictTableHtml(list, sel));
    $('#dict-count').textContent = '共 ' + META_LIST.length + ' 项，匹配 ' + list.length + ' 项';
    const cur = list.find(x => x.code === sel) || (sel ? null : list[0]);
    setHtml($('#dict-detail'), dictDetailHtml(cur));
  };
  const syncUrl = replace => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (sel) p.set('sel', sel);
    const hash = '#/dict' + (p.toString() ? '?' + p.toString() : '');
    if (location.hash !== hash) {
      if (replace) history.replaceState(null, '', hash);
      else history.pushState(null, '', hash);
    }
    lastRenderedUrl = location.href;
  };
  /* 搜索：input 事件 300ms 防抖，replaceState 不刷历史（§2.3 A 区） */
  let timer = null;
  inp.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { q = inp.value.trim(); syncUrl(true); update(); }, 300);
  });
  /* 侧栏 facet：单选，多组 AND */
  $$('.facet-side input[type=radio]').forEach(r => r.addEventListener('change', () => {
    const g = r.name.replace('facet-', '');
    DICT_FACETS[g] = r.value;
    update();
  }));
  /* 行点击：选中联动详情（URL 记 sel） */
  $('#dict-list').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-sel]'); if (!tr) return;
    sel = tr.dataset.sel;
    syncUrl(false);
    update();
  });
  update();
}

/* ==================== 12. 右键上下文菜单（§3.7 查看明细） ==================== */

let ctxEl = null;
function closeCtxMenu() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
function showCtxMenu(x, y, payload) {
  closeCtxMenu();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctxmenu';
  ctxEl.style.left = Math.min(x, window.innerWidth - 130) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - 50) + 'px';
  setHtml(ctxEl, '<button data-ctx-go="' + esc(JSON.stringify(payload)) + '">查看明细</button>');
  document.body.appendChild(ctxEl);
}
document.addEventListener('contextmenu', e => {
  const host = e.target.closest('[data-ctx]');
  if (!host) return;
  e.preventDefault();
  try { showCtxMenu(e.clientX, e.clientY, JSON.parse(host.getAttribute('data-ctx'))); } catch (err) { /* 忽略非法 payload */ }
});

/* ==================== 13. 全局事件委托与启动 ==================== */

document.addEventListener('click', e => {
  /* 右键菜单项：查看明细 → 打开抽屉（dt 入 URL） */
  const ctxGo = e.target.closest('[data-ctx-go]');
  if (ctxGo) {
    try {
      const p = JSON.parse(ctxGo.getAttribute('data-ctx-go'));
      closeCtxMenu();
      openDetailByCode(p.dim, p.code);
    } catch (err) { /* 忽略 */ }
    return;
  }
  if (e.target.closest('.ctxmenu')) return;
  closeCtxMenu();
  /* 通用跳转（卡片/入口卡/预警行） */
  const href = e.target.closest('[data-href]');
  if (href) { go(href.getAttribute('data-href')); return; }
  /* 错误重试 / 清除筛选（空态 B 主按钮） */
  if (e.target.closest('[data-retry]')) { rerender(); return; }
  const clearBtn = e.target.closest('[data-clear-filters]');
  if (clearBtn) {
    if (curSt) {
      bus.emit('filter:clear', { scope: 'all', source: 'empty-state' });
      curSt.cf = {};
      go(themeHash(curSt));
    }
    return;
  }
  /* 一键清除联动（下钻栈保留） */
  if (e.target.closest('[data-clear-linkage]')) {
    if (curSt) {
      bus.emit('filter:clear', { scope: 'all', source: 'pill-band' });
      curSt.cf = {};
      go(themeHash(curSt));
    }
    return;
  }
  /* 胶囊删除：global=重置该全局筛选；cross=filter:clear one */
  const pillX = e.target.closest('.pill-x');
  if (pillX && curSt) {
    const kind = pillX.dataset.pillKind, dim = pillX.dataset.pillDim;
    if (kind === 'cross') {
      bus.emit('filter:clear', { scope: 'one', dim: dim, source: 'pill-band' });
      delete curSt.cf[dim];
    } else if (dim === 'time') curSt.tf = DEFAULT_TF.slice();
    else if (dim === 'region') curSt.gfr = '';
    else if (dim === 'industry') curSt.gfi = '';
    go(themeHash(curSt));
    return;
  }
  /* 面包屑 / 表格行下钻（drill:nav 统一入口） */
  const drillEl = e.target.closest('[data-drill]');
  if (drillEl) {
    try { applyDrillNav(JSON.parse(drillEl.getAttribute('data-drill'))); } catch (err) { /* 忽略 */ }
    return;
  }
  /* 叶子行（市/大类）单击 → 查看明细抽屉 */
  const detEl = e.target.closest('[data-detail]');
  if (detEl) {
    const v = detEl.getAttribute('data-detail');
    const i = v.indexOf(':');
    if (i > 0) openDetailByCode(v.slice(0, i), v.slice(i + 1));
    return;
  }
  /* 维度树节点 */
  const treeNode = e.target.closest('[data-tree]');
  if (treeNode) {
    try {
      const p = JSON.parse(treeNode.getAttribute('data-tree'));
      if (p.leaf) openDetailByCode(p.dim, p.code);
      else applyDrillNav({ dim: p.dim, value: p.code, toLevel: p.dim === 'region' ? 'city' : 'c2', source: 'dim-tree' });
      dimTreeOpen = false;
      const wrap = $('#dimtree-wrap'); if (wrap) wrap.innerHTML = '';
    } catch (err) { /* 忽略 */ }
    return;
  }
});
/* Esc：逐层关闭（右键菜单 → 抽屉 → 维度树） */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (ctxEl) { closeCtxMenu(); return; }
  const wrap = $('#dimtree-wrap');
  if (wrap && wrap.innerHTML && dimTreeOpen) { dimTreeOpen = false; wrap.innerHTML = ''; return; }
  if (curSt && curSt.dt) drawerClose(curSt);
});

/* —— 缓存调试浮层（§4.7 页头辅助件：默认收起；显示最近查询 meta + 三版本因子 bump，D10/D11 演示） —— */
let cacheDebugOpen = false;
function renderCacheDebug() {
  const pop = $('#cache-debug-pop');
  if (!pop) return;
  const m = lastQueryMeta;
  setHtml(pop,
    '<h3>缓存调试</h3>' +
    (m
      ? '<dl>' +
        '<dt>最近 cacheHit</dt><dd>' + (m.cacheHit ? 'true（命中缓存）' : 'false（未命中）') + '</dd>' +
        '<dt>cacheKey</dt><dd>' + esc(m.cacheKey) + '</dd>' +
        '<dt>耗时 elapsedMs</dt><dd>' + esc(m.elapsedMs) + ' ms</dd>' +
        '<dt>watermark</dt><dd>' + esc(m.watermark) + '</dd>' +
        '<dt>metricDefVersion</dt><dd>' + esc(m.metricDefVersion) + '</dd>' +
        '<dt>dimTreeVersion</dt><dd>' + esc(m.dimTreeVersion) + '</dd>' +
        '</dl>'
      : '<div class="state-sub" style="margin-bottom:8px">尚无查询记录（浏览任一图表后此处显示 meta）</div>') +
    '<div class="bump-row">' +
      '<button data-bump="watermark">bump 数据水位</button>' +
      '<button data-bump="metricDef">bump 指标定义版本</button>' +
      '<button data-bump="dimTree">bump 维度树版本</button>' +
    '</div>');
}
function toggleCacheDebug() {
  cacheDebugOpen = !cacheDebugOpen;
  const old = $('#cache-debug-pop');
  if (old) old.remove();
  if (!cacheDebugOpen) return;
  const pop = document.createElement('div');
  pop.className = 'debug-pop';
  pop.id = 'cache-debug-pop';
  document.body.appendChild(pop);
  renderCacheDebug();
  pop.addEventListener('click', e => {
    const b = e.target.closest('[data-bump]');
    if (!b) return;
    api('/admin/watermark', { method: 'POST', body: { factor: b.dataset.bump } })
      .then(r => {
        toast('已 bump ' + b.dataset.bump + '：清空缓存 ' + (r.data && r.data.cleared) + ' 条，同查询将重算');
        renderCacheDebug();
        rerender();   // 重新取数：浮层与图表即时显示 miss
      })
      .catch(err => toast('bump 失败：' + ((err && err.message) || '未知错误')));
  });
}

/* ==================== 13b. 暗色大屏主题与投屏适配（T28 契约 §5） ====================
 * 通道优先级：?theme=dark|light URL 参数 > localStorage('sv.theme') > 默认亮色；
 * 切换按钮：写 localStorage + history.replaceState 同步 URL 参数（不刷新页面、不触发 hashchange，
 * 与路由渲染解耦）；图表走 refreshChartChrome + rethemeCharts（dispose + 缓存重渲染，不重拉数据） */
const THEME_KEY = 'sv.theme';
function urlTheme() {
  try {
    const t = new URLSearchParams(location.search).get('theme');
    return (t === 'dark' || t === 'light') ? t : null;
  } catch (e) { return null; }
}
function storedTheme() {
  try { const t = localStorage.getItem(THEME_KEY); return (t === 'dark' || t === 'light') ? t : null; }
  catch (e) { return null; }
}
function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
function resolveTheme() { return urlTheme() || storedTheme() || 'light'; }
function syncThemeUrl(t) {
  try {
    const sp = new URLSearchParams(location.search);
    if (sp.get('theme') === t) return;
    sp.set('theme', t);
    const qs = sp.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  } catch (e) { /* 忽略 */ }
}
function applyTheme(t, opts) {
  const val = t === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', val);
  try { localStorage.setItem(THEME_KEY, val); } catch (e) { /* 隐私模式忽略 */ }
  syncThemeUrl(val);
  const btn = $('#theme-toggle');
  if (btn) {
    btn.textContent = val === 'dark' ? '☀️' : '🌙';
    btn.title = val === 'dark' ? '切换亮色模式' : '切换暗色模式';
  }
  refreshChartChrome();
  if (!opts || !opts.silent) rethemeCharts();
}
/* 投屏适配通道一：?screen=tv URL 参数（通道二为 style.css §15 ≥1920px 媒体查询） */
function applyScreen() {
  try {
    if (new URLSearchParams(location.search).get('screen') === 'tv') {
      document.documentElement.setAttribute('data-screen', 'tv');
    }
  } catch (e) { /* 忽略 */ }
}

/* 身份切换：URL 不变，全量重查（RLS 由服务端按 X-Role 裁剪，§5.4） */
(function boot() {
  applyScreen();
  applyTheme(resolveTheme(), { silent: true });   // 先于首渲染：图表 init 即取正确主题变量
  const themeBtn = $('#theme-toggle');
  if (themeBtn) themeBtn.addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  /* T29 前端半：导出报告 → GET /api/v1/report?dashboard=<当前看板id>&asof=<当前asof>&role=<当前role>（契约 §3）
   * 看板 id 枚举按契约：驾驶舱 cockpit；主题看板 dash-macro / dash-tech。
   * role 走 query（报告页无 header 通道）；端点由 A17 同步开发，未上线前新开页 404 属预期（T30 联调验证） */
  const exBtn = $('#export-report-btn');
  if (exBtn) exBtn.addEventListener('click', () => {
    const route = parseHash();
    const dashboard = route.page === 'theme' ? 'dash-' + route.themeId : 'cockpit';
    const url = API_BASE + '/report?dashboard=' + encodeURIComponent(dashboard) +
      '&asof=' + encodeURIComponent(LATEST) + '&role=' + encodeURIComponent(ROLE);
    window.open(url, '_blank');
    toast('已请求报告：' + dashboard + ' · asof ' + LATEST + ' · role ' + ROLE);
  });
  const dbgBtn = $('#cache-debug-btn');
  if (dbgBtn) dbgBtn.addEventListener('click', toggleCacheDebug);
  const roleSel = $('#role-switch');
  if (roleSel) {
    roleSel.value = ROLE;
    roleSel.addEventListener('change', e => {
      ROLE = e.target.value;
      try { localStorage.setItem('sv-role', ROLE); } catch (err) { /* 隐私模式忽略 */ }
      Object.keys(memo).forEach(k => delete memo[k]);   // 缓存按角色分键，切换即失效
      toast('已切换身份：' + ROLE_NAME[ROLE] + '，正在重新查询');
      loadMetas().then(rerender);
    });
  }
  if (!location.hash) history.replaceState(null, '', '#/cockpit');
  Promise.all([loadMetas(), loadDimRoots()]).then(render);
})();

/* 总线事件观测（调试可断言：filter:click / drill:nav / global:change / filter:clear / drill:detail） */
['filter:click', 'drill:nav', 'global:change', 'filter:clear', 'drill:detail'].forEach(t =>
  bus.on(t, p => console.debug('[bus]', t, p))
);

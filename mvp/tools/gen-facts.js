'use strict';
/*
 * T02 确定性事实数据生成器 —— 统计数据可视表平台 MVP 种子
 *
 * 铁律：全部数值由「城市权重 × 行业权重 × 量级系数 × 年度水平 × 季节因子 × FNV-1a 哈希扰动」
 * 公式生成。无 Math.random / Date.now / 外部状态，任意时刻重跑输出逐字节一致（测试可复现）。
 *
 * 用法：node mvp/tools/gen-facts.js   （输出 mvp/data/facts.json，并执行自校验断言）
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'facts.json');

/* ---------- 1. 确定性哈希：FNV-1a 32bit ---------- */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** rnd(key, salt) → [0,1) 确定性均匀值 */
const rnd = (key, salt) => (fnv1a(key + '#' + salt) % 100000) / 100000;
/** 乘性扰动：±amp（amp=0.05 即 ±5%） */
const jit = (key, salt, amp) => 1 + (rnd(key, salt) - 0.5) * 2 * amp;

/* ---------- 2. 维度种子（与 dims.json 严格一致） ---------- */
// [prov, city, cityWeight]
const CITIES = [
  ['320000', '320100', 1.00], ['320000', '320500', 1.20], ['320000', '320200', 0.80], ['320000', '320600', 0.65],
  ['440000', '440100', 1.25], ['440000', '440300', 1.30], ['440000', '440400', 0.45], ['440000', '440600', 0.70],
  ['330000', '330100', 1.05], ['330000', '330200', 0.85], ['330000', '330300', 0.60], ['330000', '330400', 0.50],
  ['370000', '370100', 0.75], ['370000', '370200', 0.85], ['370000', '370600', 0.60], ['370000', '370700', 0.50],
  ['520000', '520100', 0.40], ['520000', '520300', 0.30], ['520000', '520200', 0.22], ['520000', '520400', 0.18],
];
// [c1, c2, indWeight]
const INDS = [
  ['C', '13', 1.10], ['C', '26', 1.60], ['C', '34', 1.30], ['C', '39', 2.20],
  ['I', '63', 0.80], ['I', '64', 0.70], ['I', '65', 1.00],
  ['M', '73', 0.35], ['M', '74', 0.50], ['M', '75', 0.25],
];
const HTI_C2 = new Set(['39', '64', '65', '73']);           // 高技术产业覆盖的大类
const HTI_SHARE = { '39': 0.62, '64': 0.50, '65': 0.55, '73': 0.45 };

/* ---------- 3. 时间：事实 2025-01..2026-10；生成域含虚拟 2024（不落盘） ---------- */
function monthSeq(y0, m0, y1, m1) {
  const a = []; let y = y0, m = m0;
  for (;;) { a.push(y * 100 + m); if (y === y1 && m === m1) break; m++; if (m > 12) { m = 1; y++; } }
  return a;
}
const FACT_MONTHS = monthSeq(2025, 1, 2026, 10);           // 22 个月
const yOf = ym => Math.floor(ym / 100), mOf = ym => ym % 100;
const ymStr = ym => `${yOf(ym)}-${String(mOf(ym)).padStart(2, '0')}`;
const prevYear = ym => ym - 100;

/* ---------- 4. 量级与趋势参数 ---------- */
// K：量级系数；yoy25 = 2025/2024，yoy26 = 2026/2025；amp：单元格扰动幅度
const FAM = {
  gdp:   { K: 65,   yoy25: 0.052, yoy26: 0.048, amp: 0.05 },  // 亿元，全国20市月合计约 0.9 万亿
  ind:   { K: 55,   yoy25: 0.058, yoy26: 0.046, amp: 0.06 },
  trade: { K: 40,   yoy25: 0.035, yoy26: 0.028, amp: 0.07 },
  eng:   { K: 28,   yoy25: 0.027, yoy26: 0.021, amp: 0.05 },  // 万吨标准煤，≈GDP 增速 −2.5pct
  rd:    { K: 1.9,  yoy25: 0.120, yoy26: 0.095, amp: 0.08 },  // 月度流量（亿元）；R&D 投入强度≈1.9/65≈2.9%
  pat:   { K: 1100, yoy25: 0.110, yoy26: 0.080, amp: 0.10 },  // 件
  inv:   { K: 45,   yoy25: 0.038, yoy26: 0.033, amp: 0.06 },  // 月度流量（亿元）
  emp:   { K: 0.28, yoy25: 0.005, yoy26: 0.003, amp: 0.05 },  // 月度流量（万人）
  cons:  { K: 950,  yoy25: 0.042, yoy26: 0.038, amp: 0.05 },  // 区域行（亿元）
  fin:   { K: 150,  yoy25: 0.030, yoy26: 0.026, amp: 0.06 },  // 区域行（亿元）
};
const yearLevel = (f, y) => (y === 2025 ? 1 : y === 2024 ? 1 / (1 + f.yoy25) : 1 + f.yoy26);
const SEASONAL_RAW = [0.92, 0.78, 1.06, 1.00, 1.00, 1.05, 0.97, 1.00, 1.05, 1.03, 1.05, 1.12]; // 春节低、岁末高
const SEASONAL = SEASONAL_RAW.map(v => v * 12 / SEASONAL_RAW.reduce((a, b) => a + b, 0));       // 均值归一

/* ---------- 5. 基础公式 ---------- */
const cellKey = (city, c2, ym) => `${city}|${c2}|${ym}`;
/** 当月流量：cityW×indW×K×年度水平×季节×哈希扰动（分子分母用不同 salt → 同期异动，D3） */
function flow(fam, cityW, indW, city, c2, ym, salt) {
  const f = FAM[fam];
  return cityW * indW * f.K * yearLevel(f, yOf(ym)) * SEASONAL[mOf(ym) - 1] * jit(cellKey(city, c2, ym), salt, f.amp);
}
/** 累计：本年 1..m 月流量和（内部全精度，落盘才取整） */
function cum(fam, cityW, indW, city, c2, ym) {
  let s = 0; const y = yOf(ym);
  for (let m = 1; m <= mOf(ym); m++) s += flow(fam, cityW, indW, city, c2, y * 100 + m, fam + '-flow');
  return s;
}
/** CPI 定基价格水平：2024-01 起链式月环比（含虚拟 2024 段），缓存保证一致性 */
const cpiCache = new Map();
function cpiLevel(city, ym) {
  const k = city + '|' + ym;
  if (cpiCache.has(k)) return cpiCache.get(k);
  let v;
  if (ym === 202401) {
    v = 99 + rnd(city, 'cpi-base') * 2.5; // 99.0~101.5
  } else {
    const prev = mOf(ym) === 1 ? ym - 100 + 12 : ym - 1;
    const phase = rnd(city, 'cpi-phase') * 6.2832;
    const mom = 0.0010 + (rnd(city, 'cpi-city') - 0.5) * 0.004
      + 0.0025 * Math.sin(2 * Math.PI * (mOf(ym) - 1) / 12 + phase)
      + (rnd(k, 'cpi-mom') - 0.5) * 0.005;
    v = cpiLevel(city, prev) * (1 + mom);
  }
  cpiCache.set(k, v);
  return v;
}
/** 发明专利授权占比份额：城市×大类稳定 16%~42%，月度微扰 ±2pct */
const invShare = (city, c2, ym) =>
  0.16 + 0.26 * rnd(city + '|' + c2, 'inv-share') + (rnd(cellKey(city, c2, ym), 'inv-m') - 0.5) * 0.04;
/** 研发人员全时当量（期末快照）：季度台阶漂移 + 年增 4%，无季节（时点存量） */
function rdpSnap(cityW, indW, city, c2, ym) {
  const y = yOf(ym), q = Math.floor((mOf(ym) - 1) / 3) + 1;
  const qdrift = (rnd(`${city}|${c2}|${y}Q${q}`, 'rdp-q') - 0.5) * 0.05;
  return cityW * indW * 0.09 * (1 + 0.04 * (y - 2025)) * (1 + qdrift) * jit(cellKey(city, c2, ym), 'rdp', 0.02);
}

/* ---------- 6. 预埋异常（演示主线，机器可读清单同步写入 facts.meta.anomalies） ---------- */
// A1：江苏制造业大类 规上工业增加值 同比自 2026-06 起转负、逐月加深（J1 五步主线）
const ANOM_IND = { 202606: -0.004, 202607: -0.012, 202608: -0.021, 202609: -0.032, 202610: -0.045 };
// A2：江苏制造业 综合能耗 2026-08 起不降反升 → 单位GDP能耗降低率转负（逆指标警示，D5 载体）
const ANOM_ENG = { 202608: 0.085, 202609: 0.115, 202610: 0.145 };
// A3：江苏 GDP 当月同比自 2026-06 起随制造业失速逐月回落（仍为正），累计增速降至 5 省垫底（J1 第 2 步：排名条形发现异常省）
const ANOM_GDP = { 202606: 0.040, 202607: 0.034, 202608: 0.028, 202609: 0.022, 202610: 0.018 };

/* ---------- 7. 行组装 ---------- */
const r2 = x => Math.round(x * 100) / 100;
const r1 = x => Math.round(x * 10) / 10;
const r0 = x => Math.round(x);

function industryRow(cityRec, indRec, ym) {
  const prov = cityRec[0], city = cityRec[1], cw = cityRec[2];
  const c1 = indRec[0], c2 = indRec[1], iw = indRec[2];
  const vals = {};
  // GDP（当月）+ 上年同月基值：py 与上年行同 key 同 salt，必然逐位一致；A3 覆盖（仅当期值）
  let gdp = flow('gdp', cw, iw, city, c2, ym, 'gdp');
  const gdpPy = flow('gdp', cw, iw, city, c2, prevYear(ym), 'gdp');
  if (prov === '320000' && ANOM_GDP[ym] !== undefined) gdp = gdpPy * (1 + ANOM_GDP[ym]);
  vals.gdp_va = r2(gdp);
  vals.gdp_va_py = r2(gdpPy);
  // 规上工业增加值：仅 C 门类；A1 覆盖（=上年值×(1+目标同比)，目标<0 即转负）
  if (c1 === 'C') {
    let ind = flow('ind', cw, iw, city, c2, ym, 'ind');
    const indPy = flow('ind', cw, iw, city, c2, prevYear(ym), 'ind');
    if (prov === '320000' && ANOM_IND[ym] !== undefined) ind = indPy * (1 + ANOM_IND[ym]);
    vals.ind_va = r2(ind);
  }
  // 进出口
  vals.trade_va = r2(flow('trade', cw, iw, city, c2, ym, 'trade'));
  // 综合能耗 + 基值：A2 覆盖（能耗增速超 GDP 增速 → 降低率为负）
  let eng = flow('eng', cw, iw, city, c2, ym, 'eng');
  const engPy = flow('eng', cw, iw, city, c2, prevYear(ym), 'eng');
  if (prov === '320000' && c1 === 'C' && ANOM_ENG[ym] !== undefined) eng = engPy * (1 + ANOM_ENG[ym]);
  vals.eng_con = r1(eng);
  vals.eng_con_py = r1(engPy);
  // 累计类（1..m 月流量累加，全精度）
  vals.inv_cu = r2(cum('inv', cw, iw, city, c2, ym));
  vals.emp_cu = r2(cum('emp', cw, iw, city, c2, ym));
  vals.rd_cu = r2(cum('rd', cw, iw, city, c2, ym));
  // 科技
  const pat = flow('pat', cw, iw, city, c2, ym, 'pat');
  vals.pat_va = r0(pat);
  vals.pat_inv = r0(pat * invShare(city, c2, ym));
  if (HTI_C2.has(c2)) vals.hti_va = r2(vals.gdp_va / jit(cellKey(city, c2, ym), 'gdp', FAM.gdp.amp)
    * HTI_SHARE[c2] * jit(cellKey(city, c2, ym), 'hti', 0.05)); // 由同一 GDP 原值派生，避免二次取整漂移
  vals.rdp_sn = r2(rdpSnap(cw, iw, city, c2, ym));
  return { city, prov, c1, c2, month: ymStr(ym), vals };
}

function regionRow(cityRec, ym) {
  const prov = cityRec[0], city = cityRec[1], cw = cityRec[2];
  const key = cellKey(city, 'R', ym); // 区域行独立命名空间
  const lvl = f => yearLevel(FAM[f], yOf(ym));
  return {
    city, prov, c1: null, c2: null, month: ymStr(ym),
    vals: {
      cons_va: r2(cw * FAM.cons.K * lvl('cons') * SEASONAL[mOf(ym) - 1] * jit(key, 'cons', FAM.cons.amp)),
      fin_va: r2(cw * FAM.fin.K * lvl('fin') * SEASONAL[mOf(ym) - 1] * jit(key, 'fin', FAM.fin.amp)),
      cpi_lvl: r2(cpiLevel(city, ym)),
      cpi_lvl_py: r2(cpiLevel(city, prevYear(ym))),
    },
  };
}

const rows = [];
for (const c of CITIES) for (const i of INDS) for (const ym of FACT_MONTHS) rows.push(industryRow(c, i, ym)); // 20×10×22
for (const c of CITIES) for (const ym of FACT_MONTHS) rows.push(regionRow(c, ym));                            // 20×22

/* ---------- 8. 自校验（生成后立即断言，失败即退出非 0） ---------- */
const sum = (arr, f) => arr.reduce((a, b) => a + f(b), 0);
const idx = new Map(); // city|c2|month → vals
for (const r of rows) idx.set(`${r.city}|${r.c2}|${r.month}`, r.vals);
function assert(cond, msg) { if (!cond) { console.error('SELF-CHECK FAIL: ' + msg); process.exit(1); } }

// 8.1 行数
assert(rows.length === 20 * 10 * 22 + 20 * 22, 'row count=' + rows.length);

// 8.2 py 基值一致性：2026 年每行 gdp_va_py/eng_con_py 必须与 2025 年事实行逐位相等
for (const r of rows) {
  if (r.month.startsWith('2026') && r.c2 !== null) {
    const py = idx.get(`${r.city}|${r.c2}|${String(Number(r.month.slice(0, 4)) - 1) + r.month.slice(4)}`);
    assert(py && py.gdp_va === r.vals.gdp_va_py, `gdp py mismatch ${r.city}|${r.c2}|${r.month}`);
    assert(py && py.eng_con === r.vals.eng_con_py, `eng py mismatch ${r.city}|${r.c2}|${r.month}`);
  }
}

// 8.3 A1：江苏制造业 4 大类 × 4 市，2026-06..10 同比转负且逐月加深
const jsC = rows.filter(r => r.prov === '320000' && r.c1 === 'C');
{
  const C2S = ['13', '26', '34', '39'];
  for (const city of ['320100', '320200', '320500', '320600']) {
    for (const c2 of C2S) {
      let prevYoy = Infinity;
      for (const ym of [202606, 202607, 202608, 202609, 202610]) {
        const yoy = idx.get(`${city}|${c2}|${ymStr(ym)}`).ind_va / idx.get(`${city}|${c2}|${ymStr(ym - 100)}`).ind_va - 1;
        assert(yoy < 0, `A1 yoy>=0 ${city}|${c2}|${ym}`);
        assert(yoy < prevYoy, `A1 not deepening ${city}|${c2}|${ym}`);
        prevYoy = yoy;
      }
    }
  }
}

// 8.4 对照组（省级聚合口径，即驾驶舱排名口径）：其余 4 省制造业 C 门类 2026 年各月同比均为正（异常隔离在江苏）
const provAggYoy = (prov, ym, field) => {
  const cur = sum(rows.filter(r => r.prov === prov && r.c1 === 'C' && r.month === ymStr(ym)), r => r.vals[field]);
  const py = sum(rows.filter(r => r.prov === prov && r.c1 === 'C' && r.month === ymStr(ym - 100)), r => r.vals[field]);
  return cur / py - 1;
};
for (const p of ['440000', '330000', '370000', '520000'])
  for (const ym of monthSeq(2026, 1, 2026, 10))
    assert(provAggYoy(p, ym, 'ind_va') > 0, `control ${p} ${ym} ind yoy<=0`);

// 8.5 A3：江苏 GDP 累计同比增速（GR0001，2026-10 省级 YTD）为 5 省最低（J1 第 2 步排名载体）
const gr0001Of = prov => {
  let cur = 0, py = 0;
  for (let m = 1; m <= 10; m++) {
    const mm = ymStr(202600 + m);
    const t = rows.filter(r => r.prov === prov && r.c2 && r.month === mm);
    cur += sum(t, r => r.vals.gdp_va);
    py += sum(t, r => r.vals.gdp_va_py);
  }
  return (cur / py - 1) * 100;
};
const gr0001Map = {};
for (const p of ['320000', '440000', '330000', '370000', '520000']) gr0001Map[p] = gr0001Of(p);
assert(gr0001Map['320000'] < Math.min(gr0001Map['440000'], gr0001Map['330000'], gr0001Map['370000'], gr0001Map['520000']),
  'JS GR0001 should rank last: ' + JSON.stringify(gr0001Map));

/* ---------- 9. 输出统计（供设计文档引用） ---------- */
const natGdp = sum(rows.filter(r => r.month === '2026-06' && r.c2), r => r.vals.gdp_va);
const jsIndYoy = {};
for (const ym of [202606, 202607, 202608, 202609, 202610]) {
  const cur = sum(jsC.filter(r => r.month === ymStr(ym)), r => r.vals.ind_va);
  const py = sum(jsC.filter(r => r.month === ymStr(ym - 100)), r => r.vals.ind_va);
  jsIndYoy[ymStr(ym)] = r2((cur / py - 1) * 100);
  assert(jsIndYoy[ymStr(ym)] < 0, `JS prov ind yoy >= 0 at ${ym}`);
}
const jsGR09 = {};
for (const ym of [202607, 202608, 202609, 202610]) {
  const pick = m => jsC.filter(r => r.month === m);
  const [n1, d1] = pick(ymStr(ym)).reduce((a, r) => [a[0] + r.vals.eng_con, a[1] + r.vals.gdp_va], [0, 0]);
  const [n0, d0] = pick(ymStr(ym - 100)).reduce((a, r) => [a[0] + r.vals.eng_con, a[1] + r.vals.gdp_va], [0, 0]);
  jsGR09[ymStr(ym)] = r2((1 - (n1 / d1) / (n0 / d0)) * 100);
}
const natCPI = (() => {
  const rr = rows.filter(r => r.month === '2026-10' && r.c2 === null);
  const n = sum(rr, r => r.vals.cpi_lvl), d = sum(rr, r => r.vals.cpi_lvl_py);
  return r2((n / d - 1) * 100);
})();

/* ---------- 10. 落盘 ---------- */
const payload = {
  meta: {
    version: '1.0.0',
    date: '2026-11-09',
    task: 'T02 事实数据（确定性种子）',
    generated_by: 'mvp/tools/gen-facts.js',
    deterministic: true,
    rng: 'FNV-1a 32bit 字符串哈希（无 Math.random / Date.now），重跑逐字节一致',
    grain: {
      industry_rows: 'city × industry_c2 × month（冗余 prov/c1 层级列，下钻零 JOIN）',
      region_rows: 'city × month（无行业口径指标：CPI/社零/财政收入）',
    },
    months: { from: '2025-01', to: '2026-10', count: FACT_MONTHS.length },
    rollup: '省/全国值不落盘：sum 型由市级叶子上卷求和；ratio 型按 Σ分子/Σ分母上卷',
    py_columns: 'gdp_va_py/eng_con_py/cpi_lvl_py 为上年同月基值：2026 年=事实 2025 年值；2025 年=虚拟 2024 年值（同一公式生成，与 2026 年取值路径完全一致）',
    anomalies: [
      {
        id: 'A1',
        metric: 'MACRO.IND.VA0002',
        desc: '江苏(320000)制造业(C)大类规上工业增加值同比自 2026-06 起转负、逐月加深（J1 演示主线；全国及其余省为正增长）',
        scope: { prov: '320000', c1: 'C' },
        months: { '2026-06': -0.004, '2026-07': -0.012, '2026-08': -0.021, '2026-09': -0.032, '2026-10': -0.045 },
        rule: 'ind_va = 上年同月值 × (1 + 目标同比)',
      },
      {
        id: 'A2',
        metric: 'MACRO.ENGI.GR0009',
        desc: '江苏制造业综合能耗 2026-08 起不降反升（增速超 GDP 增速），单位GDP能耗降低率转负——逆指标警示语义（D5 载体）',
        scope: { prov: '320000', c1: 'C' },
        months: { '2026-08': 0.085, '2026-09': 0.115, '2026-10': 0.145 },
        rule: 'eng_con = 上年同月值 × (1 + 目标增速)',
      },
      {
        id: 'A3',
        metric: 'MACRO.GDP.VA0001',
        desc: '江苏 GDP 当月同比自 2026-06 起随制造业失速逐月回落（仍为正增长），累计同比增速（GR0001）降至 5 省垫底（J1 第 2 步排名条形载体）',
        scope: { prov: '320000' },
        months: { '2026-06': 0.040, '2026-07': 0.034, '2026-08': 0.028, '2026-09': 0.022, '2026-10': 0.018 },
        rule: 'gdp_va = 上年同月值 × (1 + 目标同比)',
      },
    ],
    row_count: rows.length,
    stats: {
      national_gdp_2026_06_yi: r2(natGdp),
      js_ind_yoy_pct: jsIndYoy,
      js_energy_intensity_change_pct: jsGR09,
      national_cpi_yoy_2026_10_pct: natCPI,
      gr0001_prov_2026_10_pct: Object.fromEntries(Object.entries(gr0001Map).map(([p, v]) => [p, r2(v)])),
    },
  },
  rows,
};
fs.writeFileSync(OUT, JSON.stringify(payload));

/* ---------- 11. 规模校验 ---------- */
const size = fs.statSync(OUT).size;
assert(size < 2 * 1024 * 1024, `facts.json too large: ${size} bytes`);
console.log('facts.json written:');
console.log('  rows            =', rows.length, '(industry', 20 * 10 * 22, '+ region', 20 * 22, ')');
console.log('  size            =', (size / 1024 / 1024).toFixed(2), 'MB');
console.log('  national GDP 2026-06 (yi) =', r2(natGdp));
console.log('  JS ind yoy pct (A1)       =', JSON.stringify(jsIndYoy));
console.log('  JS ENGI GR0009 pct (A2)   =', JSON.stringify(jsGR09));
console.log('  national CPI yoy pct      =', natCPI);
console.log('  GR0001 prov 2026-10 (%)   =', JSON.stringify(gr0001Map, null, 0));
console.log('self-check: ALL PASS');

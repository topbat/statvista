# 统计数据可视表平台 · MVP 原型

> 零依赖 Node 语义层服务 + 零构建 vanilla JS 前端 + 本地 ECharts，一个目录拷走即跑（内网离线可演示）。
> 契约依据：`docs/mvp/03-DSL与API契约.md`（唯一取数契约）｜PRD：`docs/mvp/01-PRD.md`

## 1. 启动方式

```bash
node server/index.js          # 默认端口 3000（可带参数：node server/index.js 3001）
# 浏览器打开  http://127.0.0.1:3000
```

- 数据目录 `data/`（metrics / dims / facts / roles / **dashboards** 五个 JSON，内存加载）；
  `dashboards.json` 为 T07 产出的看板配置（dash-cockpit / dash-macro / dash-tech 三实例），服务端优先读取，缺失时回退内置兜底。
- 静态目录 `web/`（index.html / app.js / style.css / assets/echarts.min.js，与 API 同源，无需跨域）。
- 无 node_modules、无构建链、无 CDN；退出 `Ctrl+C` 即可。

## 2. 三个页面

| 路由 | 页面 | 内容 |
|------|------|------|
| `#/cockpit` | 领导驾驶舱 | A 区 8 指标卡（GDP/规上工业/CPI/就业/投资/消费/能耗(逆)/高技术）、B 区 GDP 趋势（当月柱+累计同比增速线，可切累计）、C 区省域增速排名条形（垫底 3 标红，点击下钻）、D 区异常预警（预埋）、E 区主题速通入口 |
| `#/theme/macro` `#/theme/tech` | 主题看板 | 同一模板换参数渲染（看板即 JSON）：全局筛选带（时间/地区/行业，变更清空联动）、6 指标卡、行业构成环形图（单击联动）、行业门类/大类柱线趋势、省域/市级明细表（行点击下钻、右键逐月明细）、维度树侧栏（☰） |
| `#/dict` | 指标字典 | 16 指标全字段检索（名称/编码/责任处室），侧栏 facet（主题域/agg_type/compare_policy/polarity），详情面板含口径公式、分子分母引用、允许比较、逆指标警示说明 |

URL 即终态：下钻（`r/rg/i/ig`）、联动（`cf`）、明细抽屉（`dt`）全部压缩进查询参数，复制 URL 新开标签可完整还原（D12）。

## 3. 角色切换（X-Role）

右上角"身份"切换器，三账号（RLS 由服务端按请求头 `X-Role` 编译期注入，前端永不参与安全）：

| 角色 | 效果 |
|------|------|
| `leader` | 全国口径：5 省排名、全国指标卡、全量维度树 |
| `prov-js` | 江苏口径：指标卡=本省、排名表=本省 4 市排名、维度树仅本省子树 |
| `prov-gd` | 广东口径：同上（与 prov-js 同 DSL 命中不同缓存条目，D10） |

curl 调试示例：`curl -s http://127.0.0.1:3000/api/v1/meta/metrics -H "X-Role: prov-js"`。
越权（prov-js 显式过滤广东）返回 200 空集而非报错（D7）；缓存版本因子 bump：`POST /api/v1/admin/watermark {"factor":"metricDef|watermark|dimTree"}`（D11）。

## 4. J1 领导旅程五步演示（API 级验证记录，2026-11-09 实跑）

**第 1 步 · 全国总览**（打开 `#/cockpit`，默认最新月 2026-10）
- 请求：`POST /api/v1/query` `{metrics:[MACRO.GDP.VA0001,MACRO.GDP.GR0001], dimensions:[{dim:time,granularity:time_month}], time:{grain:month,range:["2025-01","2026-10"],compare:["yoy"]}}`
- 关键数字：22 个月全部返回；2026-10 全国 GDP 当月值 **9637.97 亿元**，累计同比增速 **4.49%**；能耗强度卡按逆指标警示语义显示。

**第 2 步 · 发现江苏垫底**（悬停 C 区条形 / D 区预警行，零点击）
- 请求：同端点 `{metrics:[GR0001,VA0001], dimensions:[{dim:region,granularity:province}], time:{range:["2026-10","2026-10"],compare:["yoy"]}, sort:[{by:GR0001,order:"desc"}]}`
- 关键数字（5 省）：浙江 4.99 > 山东 4.83 > 贵州 4.80 > 广东 4.35 > **江苏 3.88（垫底标红）**；D 区预警行"规上工业增加值 · 江苏 · 同比 −4.5pct · 2026-10"。

**第 3 步 · 下钻江苏省内按市**（单击"江苏"条形 → 跳 `#/theme/macro`，面包屑"全国 › 江苏"）
- 请求：`{metrics:[VA0001], dimensions:[{dim:region,granularity:city}], filters:[{dim:region,op:"descendantOf",value:"320000"}], time:{range:["2026-10","2026-10"]}, sort desc}`
- 关键数字：4 市——苏州 786.03、南京 671.06、无锡 534.21、南通 432.17（亿元）；`meta.appliedFilters` 回显 descendantOf=active；SQL 无 JOIN。

**第 4 步 · 制造业行业构成联动**（单击环形图"制造业"扇区 → 全板变制造业口径）
- 前置构成查询（region descendantOf 320000 × industry_c1，2026-10）：制造业 C=1535.93、信息技术 I=614.56、科研服务 M=272.98（亿元）。
- 联动重取数（市级排名 + `industry in ["C"]` 带 sourceChartId=c1-industry-donut）：苏州 496.49、南京 429.54、无锡 335.89、南通 274.01（亿元）。
- 断言：再点"信息技术 I"后同维度 last-wins——`appliedFilters` 中 I=superseded、C=active，SQL 仅含 `ind_c1 IN ('C')`（D14/D15①）。

**第 5 步 · 明细定位江苏制造业负增长**（右键趋势图"制造业" → 查看明细，或明细表右键）
- 请求：`{metrics:[MACRO.IND.VA0002], dimensions:[{dim:time,granularity:time_month}], filters:[{region in ["320000"], industry in ["C"]}], time:{range:["2026-01","2026-10"],compare:["yoy","mom"]}}`
- 关键数字：2026-10 当月值 1236.79 亿元；**同比连续 5 月为负且逐月加深**：06 月 Δ−5.32、07 月 −14.38、08 月 −25.82、09 月 −42.09、10 月 −58.24（亿元，rate −0.4%→−4.5%）；负增长月标红，表底脚注 `MACRO.IND.VA0002 · 求和 · 直接比较 · 责任处室：工业统计处`。

**加演**：① 切 prov-js 同 URL 自动裁剪（D8）；prov-js 查广东 → 200 空集 rows=0（D7）；② 复制 URL 新标签还原终态（D12）；③ bump 指标定义版本 → 同查询 cache=miss（D11）；④ `#/dict` 搜"能耗" → polarity=逆 + 口径公式（D16）。

## 5. 已知限制（P0 明示）

1. **预警前端预埋**：驾驶舱 D 区异常清单为前端固定列表（app.js `PRESET_ALERTS` A1/A2/A3，数字与种子数据对齐），非服务端实时计算；`dash-cockpit` 的 `c3-alert-table` 仅为其取数引用声明。
2. **5 省种子数据**：地区仅江苏/广东/浙江/山东/贵州（各省部分市），非 31 省全量；时间窗 2025-01～2026-10（22 个月），同比基期不足的月份比较子对象缺省显示"—"。
3. **排名条形替代地图**：按 PRD §7 第 5 条，P0 不做 GeoJSON 地图，省级排名条形/排名表承载下钻职责（点击条形 ≡ 点击省图元，同一 `drill:nav` 事件与 URL 终态）；行业仅 3 门类 10 大类。
4. 其余边界：真实地图/县级/年季粒度/导出/大屏/NL2Query 等均见 PRD §7 不做清单；指标卡带混族查询由前端自动回退逐指标单查（DIM_MISMATCH 兜底）。

## 6. 目录结构

```
mvp/
├── server/index.js      # T05 语义层服务（/api/v1/query + 3 meta 端点 + 静态服务）
├── web/                 # T06 前端（vanilla JS 单页 + 本地 echarts.min.js）
│   ├── index.html / app.js / style.css
│   └── assets/echarts.min.js
├── data/                # T02 种子（metrics/dims/facts/roles）+ T07 dashboards.json
└── tools/               # 冒烟脚本（smoke）
```

# 统计数据可视表平台 · MVP 查询 DSL 与 REST API 契约

> 文档编号：MVP-03 ｜ 任务：T03 DSL 与 API 契约 ｜ 版本 v1.0 ｜ 2026-11-09
> 依据：《统计数据可视表平台设计方案》v1.0（§3.4 权限与缓存 / §3.5 查询 DSL / §3.2 联动冲突矩阵）、《MVP PRD》（MVP-01，§2 冻结范围 / §3 DoD D1–D17）
> 地位：**本文档是原型唯一取数契约**。T02（黄金用例集）、T05（语义层实现）、T06（前端）凡与本文档命名不一致处，**以本文档为准**，并按下方"字段命名规范表"对齐。

---

## 0. 字段命名规范表（供 T02 / T05 / T06 对齐）

| # | 本契约定稿命名 | 其他文档中的对应写法 | 对齐说明 |
|---|---------------|---------------------|---------|
| N1 | `granularity: "province" / "city"` | PRD §2.5 示例 `prov` / `city` | 地区粒度用全称 `province`；PRD 示例中的 `prov` 视为简写，T05 不得接受 |
| N2 | `granularity: "industry_c1" / "industry_c2"` | PRD §2.5 示例 `c1` / `c2`；设计方案 §5.1 列名 `ind_c1 / ind_c2` | DSL 层带维度前缀；事实表列名仍为 `ind_c1 / ind_c2`（T02 黄金 SQL 用列名） |
| N3 | `granularity: "time_month"` | PRD `time.grain: "month"` | 作为 dimensions 显式声明时用 `time_month`；`time.grain` 仍为 `month`（两处语境不同，不冲突） |
| N4 | `dim: "region" / "industry" / "time"` | 设计方案 `维度`；事实表 `region_prov / region_city / ind_c1 / ind_c2 / month` | DSL 逻辑维度名与物理列名映射见 §2.2.2 |
| N5 | `X-Role` 请求头 | PRD §2.4 演示账号 leader / prov-js / prov-gd | 原型唯一认证方式（PRD §4.3：原型不做真鉴权，仅模拟身份） |
| N6 | `meta.cacheHit`（boolean） | PRD §3 读法 `meta.cache=hit` | PRD 文案"cache=hit"对应 `meta.cacheHit === true` |
| N7 | `filters[].sourceChartId` | 设计方案 §3.2 事件 `source` | 联动溯源字段；不参与缓存键（§2.7） |
| N8 | `data[].dims / data[].metrics` | — | 响应行内维度值桶 / 指标值桶两级分桶 |
| N9 | `dashboardId / chartId` | 设计方案 §2 `chart-能耗行业构成` | 标识符格式：`dash-<domain>` / `c<序号>-<slug>`，见 §6 |
| N10 | 图表取数声明字段名 `dataset` | 设计方案 §2 "图表只引用指标编码 + 维度分配" | 看板 JSON 内嵌的查询声明，结构为 QueryRequest 子集 + 默认值 |
| N11 | `emits / subscribes` | 设计方案 §3.2 联动声明 | 图表联动声明，事件类型沿用 §3.2 协议（`filter:click` / `drill:nav`） |
| N12 | `drillPath` | 设计方案 §3.1 前端下钻状态 `{维度: 当前节点}` | 看板/图表初始下钻路径声明 |
| N13 | 错误结构 `{error:{code,message,detail,traceId}}` | PRD D2/D4 "4xx + 明确错误文案" | 错误码表见 §2.4.2 |
| N14 | 缓存键版本因子 `watermark / metricDefVersion / dimTreeVersion` | 设计方案 §3.4 "数据水位线 / 指标定义版本 / 维度树版本"；PRD D11 | 三版本号同时出现在响应 `meta` 与调试面板 |
| N15 | BASE URL `http://127.0.0.1:3000/api/v1` | 未约定 | 原型服务端口约定 3000；T05 实现若变更须回写本表 |
| N16 | 维度值物化路径字段 `path`（如 `/320000/`） | 设计方案 §2 维度值 `path` | `descendantOf` 编译产物与 RLS 谓词共用此前缀语义 |

**通用约定**：所有请求/响应均为 UTF-8 JSON；时间一律 `YYYY-MM`（月粒度）；编码、角色、维度名大小写敏感；布尔用 `true/false`；未知字段处理见 §2.1 附注（剥离忽略，防参数注入，D9）。

---

## 1. 总则

| 项 | 约定 |
|----|------|
| BASE URL | `http://127.0.0.1:3000/api/v1`（N15） |
| 认证 | 请求头 `X-Role: leader \| prov-js \| prov-gd`；缺失或非法 → 401（§2.6） |
| 数据边界（P0 冻结） | 指标 16 个（PRD §2.2）；地区 全国→省→市；行业 门类→大类；时间 2024-01 ～ 2026-10，月粒度 |
| 编译语义 | `最终 WHERE = RLS ∩ 显式过滤 ∩ (下钻等值条件)`；同环比由语义层独占计算（一次查询多子查询） |
| 幂等 | 全部端点只读（POST /query 语义为"执行查询"，无副作用），天然幂等 |
| 审计 | 每个请求写审计日志：角色、规范化 DSL、剥离的未知字段、命中缓存与否、编译 SQL |

---

## 2. POST /api/v1/query —— 查询主端点

### 2.1 请求体完整 JSON Schema（draft-07）

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://statviz.local/schemas/v1/query-request.schema.json",
  "title": "QueryRequest",
  "type": "object",
  "required": ["metrics", "time"],
  "properties": {
    "metrics": {
      "type": "array",
      "minItems": 1,
      "maxItems": 8,
      "items": {
        "type": "string",
        "pattern": "^(MACRO|TECH)\\.[A-Z0-9_]+\\.[A-Z0-9]{6}$",
        "description": "只允许 PRD §2.2 冻结的 16 个注册编码，禁止裸 SQL（D2）"
      }
    },
    "dimensions": {
      "type": "array",
      "maxItems": 3,
      "default": [],
      "items": { "$ref": "#/definitions/dimensionDecl" }
    },
    "filters": {
      "type": "array",
      "default": [],
      "description": "过滤节点数组，数组语义 = 元素间 AND；任一元素可为递归 and/or/not 树或叶子",
      "items": { "$ref": "#/definitions/filterNode" }
    },
    "time": { "$ref": "#/definitions/timeDecl" },
    "sort": {
      "type": "array",
      "default": [],
      "items": {
        "type": "object",
        "required": ["by"],
        "properties": {
          "by": {
            "type": "string",
            "description": "指标编码（如 MACRO.GDP.VA0001）或维度排序键 dim:region / dim:industry / dim:time"
          },
          "order": { "enum": ["asc", "desc"], "default": "desc" }
        }
      }
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000,
      "default": 50
    }
  },
  "definitions": {
    "dimensionDecl": {
      "type": "object",
      "required": ["dim", "granularity"],
      "properties": {
        "dim": { "enum": ["region", "industry", "time"] },
        "granularity": {
          "enum": ["province", "city", "industry_c1", "industry_c2", "time_month"]
        }
      },
      "allOf": [
        {
          "if": { "properties": { "dim": { "const": "region" } } },
          "then": { "properties": { "granularity": { "enum": ["province", "city"] } } }
        },
        {
          "if": { "properties": { "dim": { "const": "industry" } } },
          "then": { "properties": { "granularity": { "enum": ["industry_c1", "industry_c2"] } } }
        },
        {
          "if": { "properties": { "dim": { "const": "time" } } },
          "then": { "properties": { "granularity": { "const": "time_month" } } }
        }
      ]
    },
    "filterNode": {
      "oneOf": [
        { "$ref": "#/definitions/andNode" },
        { "$ref": "#/definitions/orNode" },
        { "$ref": "#/definitions/notNode" },
        { "$ref": "#/definitions/leafFilter" }
      ]
    },
    "andNode": {
      "type": "object",
      "required": ["comb", "children"],
      "properties": {
        "comb": { "const": "and" },
        "children": {
          "type": "array",
          "minItems": 1,
          "items": { "$ref": "#/definitions/filterNode" }
        }
      }
    },
    "orNode": {
      "type": "object",
      "required": ["comb", "children"],
      "properties": {
        "comb": { "const": "or" },
        "children": {
          "type": "array",
          "minItems": 2,
          "items": { "$ref": "#/definitions/filterNode" }
        }
      }
    },
    "notNode": {
      "type": "object",
      "required": ["comb", "child"],
      "properties": {
        "comb": { "const": "not" },
        "child": { "$ref": "#/definitions/filterNode" }
      }
    },
    "leafFilter": {
      "type": "object",
      "required": ["dim", "op"],
      "properties": {
        "dim": { "enum": ["region", "industry", "time"] },
        "op": { "enum": ["in", "descendantOf", "time_range"] },
        "values": {
          "type": "array",
          "minItems": 1,
          "maxItems": 50,
          "items": { "type": "string" },
          "description": "op=in 时必填：维度值编码列表，如 [\"C\"] 或 [\"320000\",\"440000\"]"
        },
        "value": {
          "type": "string",
          "description": "op=descendantOf 时必填：单个维度节点编码，服务端解析物化 path 后编译为前缀过滤（下钻语义）"
        },
        "range": {
          "type": "array",
          "items": { "type": "string", "pattern": "^\\d{4}-(0[1-9]|1[0-2])$" },
          "minItems": 2,
          "maxItems": 2,
          "description": "op=time_range 时必填：[起月, 止月]，闭区间"
        },
        "sourceChartId": {
          "type": "string",
          "description": "可选。联动溯源：该过滤由哪个图表的 cross-filter 产生；仅用于冲突消解审计与 meta 回显，不影响查询语义、不参与缓存键（§2.2.4）"
        }
      },
      "allOf": [
        {
          "if": { "properties": { "op": { "const": "in" } } },
          "then": { "required": ["values"] }
        },
        {
          "if": { "properties": { "op": { "const": "descendantOf" } } },
          "then": { "required": ["value"] }
        },
        {
          "if": { "properties": { "op": { "const": "time_range" } } },
          "then": { "required": ["range"] } 
        },
        {
          "if": { "properties": { "dim": { "const": "time" } } },
          "then": { "properties": { "op": { "const": "time_range" } } }
        }
      ]
    },
    "timeDecl": {
      "type": "object",
      "required": ["grain", "range"],
      "properties": {
        "grain": { "const": "month" },
        "range": {
          "type": "array",
          "items": { "type": "string", "pattern": "^\\d{4}-(0[1-9]|1[0-2])$" },
          "minItems": 2,
          "maxItems": 2,
          "description": "[起月, 止月] 闭区间；服务端校验落在 2024-01 ～ 2026-10 且起 ≤ 止，否则 INVALID_TIME_RANGE"
        },
        "compare": {
          "type": "array",
          "items": { "enum": ["yoy", "mom"] },
          "uniqueItems": true,
          "default": [],
          "description": "请求的比较类型；是否被接受由每个指标的 compare_policy 裁决（§2.5），冲突 → 403 COMPARE_POLICY_FORBIDDEN"
        }
      }
    }
  }
}
```

**附注（未知字段策略，D9）**：请求体中出现本 Schema 未声明的字段（包括任何伪造的 `rls`、`role`、`region` 授权类参数）时，服务端**不报错、在规范化阶段剥离**，行为与不带这些字段时逐字节一致，剥离内容记入审计日志。RLS 谓词只来自 `X-Role` 对应的账号绑定，绝不接受请求体传参。

### 2.2 字段语义

#### 2.2.1 metrics

- 只允许 PRD §2.2 冻结的 16 个注册编码；未注册编码 → 404 `METRIC_NOT_FOUND`（D2），不产生任何数据查询。
- 同一编码重复出现视为一次（规范化去重）。
- 多指标必须可由**同一单事实表**承载（P0 冻结：DSL 范围为单事实表、无 JOIN，PRD §2.1）；不兼容 → 400 `DIM_MISMATCH`，`detail` 指明冲突指标对与其所属事实表。

#### 2.2.2 dimensions 与逻辑/物理列映射

| dim | granularity | 语义 | 编译产物（GROUP BY） | 事实表物理列 |
|-----|-------------|------|---------------------|--------------|
| region | province | 省级 | `GROUP BY region_prov` | `region_prov` |
| region | city | 市级 | `GROUP BY region_city` | `region_city`（冗余列，下钻零 JOIN） |
| industry | industry_c1 | 行业门类 | `GROUP BY ind_c1` | `ind_c1` |
| industry | industry_c2 | 行业大类 | `GROUP BY ind_c2` | `ind_c2` |
| time | time_month | 月 | `GROUP BY month` | `month` |

- `dimensions` 缺省 = 指标卡场景（不分组，返回单行总量）。
- 同一 `dim` 只允许声明一次（两个粒度并存无业务意义）→ 400 `DSL_SCHEMA_INVALID`。

#### 2.2.3 filters：递归树 + 操作符

- **树结构**：`filters` 数组元素间 AND；`{comb:"and"|"or", children:[...]}` 递归组合，`{comb:"not", child:{...}}` 取反。
- **操作符**：
  - `in`：`WHERE <物理列> IN ('v1','v2',...)`；
  - `descendantOf`：**下钻语义**。`value` 为维度节点编码（如 `"320000"`），服务端查维表取其物化 `path`（如 `/320000/`），编译为 `WHERE <path 列> LIKE '/320000/%'`。与 granularity 配合即"钻入该节点下一级"：`{dim:region, granularity:city}` + `descendantOf 320000` ⇒ `WHERE region_prov='320000' GROUP BY region_city`（等价编译，物理层用冗余列等值过滤，两者择一由编译器定，黄金 SQL 用例固定其一）；
  - `time_range`：`WHERE month BETWEEN '2026-01' AND '2026-10'`（仅 dim=time）。
- **与 time.range 的关系**：`time.range` 是主时间窗口；`filters` 里的 `time_range` 是显式过滤，二者**取交集**（更窄者生效）。为避免歧义，同一请求两者都用时 `filters.time_range` 必须是 `time.range` 的子区间，否则 400 `INVALID_TIME_RANGE`。

#### 2.2.4 联动语义：sourceChartId 与冲突矩阵（同维度 last-wins）

前端事件总线（设计方案 §3.2）负责 cross-filter 栈：同维度多事件 last-wins、异维度 AND、全局筛选器变更清空全板 cross-filter 栈、下钻栈保留。**服务端契约是这套规则的后半边兜底**，规则如下：

1. **规范化消解**：编译前将 `filters` 中位于**纯 AND 上下文**（不穿过 or/not 分支）的同 `dim` 值类叶子（`in` 与 `descendantOf` 视为同类"值过滤"）按**数组出现顺序 last-wins**——仅保留最后一个，其余剥离。位于 or/not 分支内的叶子不参与消解（语义不同，全部保留）。
2. **审计回显**：消解后被剥离与生效的叶子连同 `sourceChartId` 写入响应 `meta.appliedFilters`，前端据此渲染过滤胶囊（橙=带 sourceChartId 的联动过滤，蓝=全局筛选）。
3. **缓存无感**：`sourceChartId` 与被消解的叶子在规范化时剥离，**不参与缓存键**（§2.7）——同一最终语义的联动查询命中同一缓存。
4. **最终 WHERE 恒等式**：`RLS ∩ 全局筛选 ∩ Σ cross-filter（消解后）`，与设计方案 §3.2 完全一致（D15）。

#### 2.2.5 sort / limit

- `sort.by`：指标编码（按值排序）或 `dim:<dim名>`（按维度编码排序）；未声明时按维度编码升序、其次按第一个指标降序。
- `limit`：默认 50，上限 1000；结果被截断时 `meta.truncated=true`。

### 2.3 响应结构（HTTP 200）

```json
{
  "data": [
    {
      "dims": {
        "region": { "code": "320000", "name": "江苏省", "path": "/320000/" }
      },
      "metrics": {
        "MACRO.GDP.VA0001": {
          "value": 10536.7,
          "yoy":  { "policy": "direct",              "base": 9812.3, "delta": 724.4, "rate": 0.0738 },
          "mom":  { "policy": "direct",              "base": 10201.5, "delta": 335.2, "rate": 0.0329 }
        },
        "MACRO.GDP.GR0001": {
          "value": 5.2,
          "yoy":  { "policy": "compare_then_compute", "base": 5.9, "delta": -0.7, "rate": null },
          "mom":  { "policy": "compare_then_compute", "base": 5.4, "delta": -0.2, "rate": null }
        }
      }
    }
  ],
  "meta": {
    "cacheHit": false,
    "cacheKey": "a1b2c3d4",
    "watermark": "wm-20261108-01",
    "metricDefVersion": "md-3",
    "dimTreeVersion": "dt-1",
    "elapsedMs": 14,
    "rlsRole": "leader",
    "rlsApplied": null,
    "appliedFilters": [
      { "dim": "industry", "op": "in", "values": ["C"], "sourceChartId": "c2-industry-mix", "status": "active" },
      { "dim": "industry", "op": "in", "values": ["F"], "sourceChartId": "c2-industry-mix", "status": "superseded" }
    ],
    "sql": "SELECT region_city AS dim_region, SUM(ind_va) AS m_MACRO_IND_VA0002 FROM fact_macro WHERE region_prov = '320000' AND ind_c1 IN ('C') AND month BETWEEN '2026-09' AND '2026-10' GROUP BY region_city",
    "rows": 13,
    "truncated": false
  }
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `data[].dims` | object | 每个声明维度的值：`code/name/path`；`path` 仅 region/industry 有；`dim:time` 的 code 为 `"2026-09"` 形式、name 同 code。无 `dimensions` 声明时该桶为空对象（指标卡单行） |
| `data[].metrics.<编码>.value` | number \| null | 当期值（按指标 `agg_type` 聚合后）；null=口径不适用（见下方修订注） |
| `data[].metrics.<编码>.yoy/.mom` | object \| 缺省 | 仅当请求 `time.compare` 含该类型**且**指标 `compare_policy` 允许时返回；结构 `{policy, base, delta, rate}`（§2.5）。未请求或被策略禁止时整个子对象缺省（不是 null） |
| `meta.cacheHit` | boolean | 是否命中缓存（N6；D10） |
| `meta.cacheKey` | string | 缓存键 sha256 前 8 位（脱敏展示，便于断言 leader 与 prov-js 键不同） |
| `meta.watermark` / `metricDefVersion` / `dimTreeVersion` | string | 缓存键三版本因子（N14；D11），与调试面板 bump 事件一一对应 |
| `meta.elapsedMs` | number | 服务端处理耗时 |
| `meta.rlsRole` | string | 本次请求生效角色（由 X-Role 解析） |
| `meta.rlsApplied` | object \| null | RLS 裁剪说明（§2.6.3）：leader 为 null；省用户为 `{dim:"region", predicate:"path LIKE '/320000/%'", scopePath:"/320000/", visibleRoot:"320000"}` —— D8 断言"响应中不存在 region_path 不以 /320000/ 开头的数据行"以此佐证 |
| `meta.appliedFilters` | array | 规范化消解后**生效（active）与被覆盖（superseded）**的过滤叶子回显（§2.2.4），联动胶囊与 last-wins 断言（D15①）依据 |
| `meta.sql` | string | 编译产物 SQL（**断言无 JOIN**，D1；黄金用例比对物；PRD §3"meta 携带编译产物"条款） |
| `meta.rows` / `meta.truncated` | number / boolean | 返回行数 / 是否被 limit 截断 |

**空结果集**（D7）：RLS 与显式过滤交集为空时返回 HTTP 200、`data: []`、`rows: 0`，不报错、不泄露他省数据是否存在。

**口径不适用**（【T09 修订，2026-11-09】）：声明的维度组合在事实表中有行、但该指标支撑字段无任何取值（如 `ind_va` 仅存于 C 门类，查询 I 门类大类）时，**该组行保留返回、`value` 为 `null`**，`yoy/mom` 子对象缺省；不剔除该组行。此为与"空结果集"（整组行不存在）并列的两种空语义之二，前端按 `value=null` 渲染空态。metrics.json `store.rows` 原表述"查询返回空集"以本条为准修正（BUG-02 处置）。

### 2.4 错误结构

#### 2.4.1 结构

```json
{
  "error": {
    "code": "METRIC_NOT_FOUND",
    "message": "指标编码未注册：MACRO.GDP.XX9999",
    "detail": { "metric": "MACRO.GDP.XX9999", "registeredCount": 16 },
    "traceId": "t-20261109-0001"
  }
}
```

`detail` 恒为 object（无细节时为 `{}`）；`message` 为中文人读文案；`traceId` 关联审计日志。错误响应**不含** `data`/`meta`。

#### 2.4.2 错误码表

| HTTP | code | 触发条件 | detail 关键字段 | 关联 DoD |
|------|------|---------|----------------|----------|
| 400 | `DSL_SCHEMA_INVALID` | 请求体不符合 §2.1 Schema（粒度×维度错配、sort.by 非法、结构破损等） | `pointer`（JSON 指针）、`reason` | D2 |
| 404 | `METRIC_NOT_FOUND` | `metrics` 引用未注册编码 | `metric` | D2 |
| 400 | `DIM_MISMATCH` | 多指标不属于同一事实表；或 dimension/filter 维度与指标数据集不兼容 | `metrics[]`、`dimension` | — |
| 400 | `BAD_FILTER` | 过滤树结构非法：叶子缺 op 必填值、`in` 空数组、notNode 多子节点、值编码不在维表 | `filter`、`reason` | — |
| 400 | `INVALID_TIME_RANGE` | range 越出 2024-01～2026-10、起>止、月份格式非法、filters.time_range 非 time.range 子区间 | `range`、`allowed` | — |
| 403 | `COMPARE_POLICY_FORBIDDEN` | `time.compare` 与指标 `compare_policy` 冲突：cumulative×mom、snapshot×mom、禁比较指标×任意 compare | `metric`、`policy`、`requested` | D4 |
| 403 | `FORBIDDEN_BY_RLS` | 数据集级 RLS 拒绝（该角色对该数据集**整体**无权）。P0 两角色对 16 指标均可见，本码在原型不触发；**行级越权（如 prov-js 查广东）不触发此码，返回 200 空集**（D7） | `dataset`、`role` | D7（反证边界） |
| 401 | `UNAUTHENTICATED` | `X-Role` 缺失或不在 {leader, prov-js, prov-gd} 内 | `received` | — |
| 500 | `INTERNAL` | 服务端兜底 | `{}` | — |

> D2 的断言口径：未注册编码或夹带裸 SQL 片段（如 `metrics: ["GDP; DROP TABLE"]` 不匹配编码 pattern）→ 4xx（404/400），且审计日志留痕、无任何数据查询发生。

### 2.5 同环比计算规则（compare_policy 三策略 + 预留）

同环比由语义层**独占计算**：一次 DSL 查询编译为多子查询（当期/同期/上期），与下钻维度正交——下钻换维度时时间子句原样传递（D6）。所有响应值对象的 `policy` 字段回显所用算法（D3 断言依据）。

| compare_policy | 允许的比较 | yoy 算法 | mom 算法 | 冲突时行为 |
|----------------|-----------|----------|----------|-----------|
| `direct`（sum 可加当期值：#1 #3 #6 #7 #8 #13 #15） | yoy + mom | `base`=去年同期聚合值；`delta=value-base`；`rate=delta/\|base\|` | `base`=上月聚合值，同式 | — |
| `compare_then_compute`（ratio 比值：#2 #4 #10 #12 #14） | yoy + mom | **先分别聚合分子、分母的当期与同期值，再各算比值，delta=两比值之差（pct 点）**；`rate=null`（点差无比率意义）。禁止对结果值直接相减 | 同理：分子分母取上月值重算 | — |
| `cumulative`（累计：#5 #9 #11） | **仅 yoy** | 当期累计值 vs 去年同月累计值（direct 式） | **拒绝** → 403 `COMPARE_POLICY_FORBIDDEN`（detail: policy=cumulative, requested=mom） | D4：UI 侧环比入口置灰由 meta/metrics 端点的元数据驱动 |
| `snapshot`（快照：#16） | 仅 yoy | 期末快照 vs 上年同期快照（direct 式） | 拒绝 → 403 同上 | — |
| `window_sum`（P0 预留，16 指标无实例） | yoy | 当期滚动窗口Σ vs 同期窗口Σ（窗口宽度取指标元数据 `windowMonths`），先各自求和再比较（direct 式） | 视元数据声明 | 契约预留，T05 须留分支 |

**compare_then_compute 数值示例（D3 断言载体）**：GDP 累计同比增速，分子=当期累计增加值，分母=去年同期累计增加值。演示数据预埋分子分母同期异动，使正确算法（先比分母分母再算比值差）与错误算法（对结果值直接相减）差 ≥ 0.1pct——断言响应采用前者：

```
正确（契约）：yoy.delta = (num_t/den_t) − (num_{t-12m}/den_{t-12m})        = -0.7 pct
错误（禁止）：yoy.delta = (num_t/den_t) − (num_{t-12m}/den_t) 或直接 value−value' = -0.2 pct
```

**未请求 compare**：响应不含 yoy/mom 子对象（缺省而非 null），不产生额外子查询。**值对象嵌套结构统一**：`{policy, base, delta, rate}`，ratio 型 `rate=null`；正逆指标展示语义（红涨绿跌/警示文案、箭头+数值同显）由前端依据 `/api/v1/meta/metrics` 的 `polarity` 渲染（D5），契约只保证数值与算法正确。

### 2.6 认证与 RLS

#### 2.6.1 认证（原型）

- 唯一方式：请求头 `X-Role: leader | prov-js | prov-gd`（N5）。生产替换为统一鉴权，注入点不变（PRD §4.3 映射表）。
- 缺失/非法 → 401 `UNAUTHENTICATED`；角色值即"RLS 角色桶"，不做按人授权（P0 冻结）。

#### 2.6.2 RLS 裁剪逻辑（编译期注入，region path 前缀过滤）

| X-Role | 绑定机构节点 | 注入谓词（编译期，前端不传、不可覆盖） | 效果 |
|--------|-------------|------------------------------------------|------|
| leader | 全国（根） | 无（全量） | 31 省排名、全国口径指标卡 |
| prov-js | 江苏 320000 | `region_path LIKE '/320000/%'` | 省口径指标卡；排名表=本省 13 市排名；维度树仅本省子树（D8） |
| prov-gd | 广东 440000 | `region_path LIKE '/440000/%'` | 同上（21 市） |

- 谓词生成规则：账号绑定机构节点 → 该节点物化 path → `path LIKE '<scopePath>%'`，注入位置在 **RLS 区**（`最终 WHERE = RLS ∩ 显式过滤 ∩ Σ cross-filter` 的第一段），与用户显式过滤**交集**合成。
- **行级越权**（D7）：prov-js 显式 `descendantOf 440000` ⇒ 交集为空 ⇒ 200 + `data:[]`，绝不报错、绝不泄露他省数据存在性。
- **参数注入免疫**（D9）：请求体/URL 中任何 `rls`、`region` 授权类字段在规范化阶段剥离（§2.1 附注），行为逐字节一致。
- `descendantOf` 的 value 若在 RLS 范围外（如 prov-js 传 440000），同样走空集路径——语义统一，无需特判。

#### 2.6.3 meta.rlsApplied

- leader：`null`。
- prov-*：`{ "dim": "region", "predicate": "path LIKE '/320000/%'", "scopePath": "/320000/", "visibleRoot": "320000" }` —— 说明被裁剪维度（region）与裁剪范围；前端据此初始化维度树根与看板默认 granularity（省用户排名图用 `city`）。

### 2.7 缓存键公式、TTL 与失效

**键公式**（对应设计方案 §3.4 四因子，RLS 指纹以角色桶表达）：

```
cacheKey = sha256(
  "v1" | role | canonicalDSL | watermark | metricDefVersion | dimTreeVersion
)            // "|" 为字面分隔符；sha256 十六进制取前 8 位展示为 meta.cacheKey

canonicalDSL 规范化规则：
  1. 剥离全部非契约字段与 sourceChartId（D9、§2.2.4-3）
  2. 执行过滤消解（纯 AND 上下文同 dim 值叶子 last-wins），丢弃 superseded 叶子
  3. 对象键排序（key-sort）后稳定序列化；filters 数组保持出现顺序（消解依赖顺序，消解后排序）
  4. 补全默认值：dimensions=[]、filters=[]、sort=[]、limit=50、compare=[]
  5. metrics 去重并按字典序排序；sort 未声明时补默认排序
```

**为什么 role 而非用户**：P0 RLS 收敛为角色桶（PRD §2.4），同桶同键——D10 断言"leader 与 prov-js 同一 DSL 命中不同缓存条目"由 role 因子保证。

**TTL 与失效**：

| 机制 | 约定 |
|------|------|
| TTL 兜底 | 进程内缓存默认 300s（原型常量，可配）；到期后同键 miss 重算 |
| 失效事件（主动，换键即失效） | ① `metricDefVersion` bump（口径修订）② `watermark` bump（新批次入库）③ `dimTreeVersion` bump（区划/行业树调整）——调试面板三个按钮（D11），bump 后同一请求 `meta.cacheHit=false` |
| 不参与键 | `sourceChartId`、被消解的过滤叶子、请求 ID、响应排序以外的展示性字段 |
| 验收口径 | 改口径（bump ①）后同一查询立即重算并返回新结果（原型即时生效；生产 60s 全端可见由广播保证） |

---

## 3. GET /api/v1/meta/metrics —— 指标字典（供前端渲染与 D16）

**用途**：字典页全量元数据；驾驶舱/看板指标卡与比较入口的**元数据驱动渲染源**（新增指标不改前端代码即正确渲染，D16②）。

### 3.1 请求

```
GET /api/v1/meta/metrics?domain=macro|tech&q=能耗&agg_type=ratio&compare_policy=compare_then_compute&polarity=inverse
X-Role: leader            # 所有角色可见（元数据不涉密）；查询参数均可选，q 匹配 名称/编码/责任处室
```

### 3.2 响应（HTTP 200，结构）

```json
{
  "data": [
    {
      "code": "MACRO.ENGI.GR0009",
      "name": "单位 GDP 能耗降低率",
      "domain": "macro",
      "unit": "%",
      "aggType": "ratio",
      "comparePolicy": "compare_then_compute",
      "polarity": "inverse",
      "formula": "（基期能耗 − 报告期能耗）/ 基期能耗 × 100%",
      "numeratorRef": "MACRO.ENGI.EnergyTotal",
      "denominatorRef": "MACRO.GDP.VA0001",
      "ownerDept": "能源处",
      "basisDocNo": "统发〔2024〕XX 号（占位）",
      "updateFreq": "monthly",
      "dataClass": "general",
      "windowMonths": null,
      "allowedCompares": ["yoy", "mom"]
    }
  ],
  "meta": { "count": 16, "metricDefVersion": "md-3", "filtered": 1 }
}
```

**要点**：
- `aggType / comparePolicy / polarity` 为**结构化字段**而非文档描述（PRD §2.2、D16①），枚举：`aggType ∈ sum|ratio|cumulative|snapshot`，`comparePolicy ∈ direct|compare_then_compute|cumulative|snapshot|window_sum|none`，`polarity ∈ positive|inverse`。
- `allowedCompares` 是服务端按 `comparePolicy` 预计算的合法比较类型数组，前端据此置灰环比入口（D4②），避免先发请求再吃 403。
- `numeratorRef/denominatorRef`：ratio 型必填（compare_then_compute 的执行依据，§2.5）；其余类型为 null。`windowMonths`：window_sum 型必填。
- 字典**临时新增测试指标**（D16②）走同一注册表，本端点立即返回——验证渲染元数据驱动。

## 4. GET /api/v1/meta/dims —— 维度树（受 RLS 裁剪）

**用途**：维度树侧栏、面包屑、下钻目标与过滤器的候选项来源；省用户只见本省子树（D8）。

### 4.1 请求

```
GET /api/v1/meta/dims?dim=region|industry&parent=320000&depth=1
X-Role: prov-js
# parent 缺省 = 根（leader 的 region 根为"全国"虚拟节点 ROOT；prov-js 的 region 根自动改写为本省节点）
# depth 缺省 = 1（只取一层，懒加载）；P0 层级：region 两级、industry 两级
```

### 4.2 响应（HTTP 200，结构）

```json
{
  "data": [
    { "code": "320100", "name": "南京市", "parentCode": "320000", "path": "/320000/320100/", "level": 2, "isLeaf": true }
  ],
  "meta": { "dim": "region", "parent": "320000", "count": 13, "dimTreeVersion": "dt-1", "rlsApplied": { "dim": "region", "scopePath": "/320000/", "visibleRoot": "320000" } }
}
```

**要点**：
- **RLS 裁剪在此端点同样生效**：prov-js 请求 `parent=440000`（广东）→ 200 + `data:[]`（与 D7 同语义，不报错）；请求根 → 根即江苏（可见根改写），树中永不出现省外节点。
- `isLeaf`：region 的市为叶（P0 无县级）、industry 的大类为叶；前端据 `isLeaf` 判断下钻是否到底。
- `dimTreeVersion` 随响应返回，bump 后前端应重新拉取（缓存失效三因子之一）。

## 5. GET /api/v1/meta/dashboard/{id} —— 看板配置（供前端渲染）

**用途**：主题看板"同一模板换参数渲染"的最小证明（PRD §5.2：看板即 JSON）；驾驶舱亦按同 schema 的实例下发。

### 5.1 请求

```
GET /api/v1/meta/dashboard/dash-macro     # ∈ { dash-cockpit, dash-macro, dash-tech }（P0 三个实例）
X-Role: prov-js                            # 配置本身对全角色相同；数据裁剪发生在 /query（角色只影响取数与维度树）
```

### 5.2 响应（HTTP 200，结构）

```json
{
  "data": { "dashboardId": "dash-macro", "...": "见 §6 完整 Schema" },
  "meta": { "version": "1.0.0", "etag": "cfg-7f2a", "dimTreeVersion": "dt-1", "metricDefVersion": "md-3" }
}
```

**要点**：`data` 即 §6 看板 JSON 原文（服务端原样下发，不做角色改写）；`meta.etag` 供前端缓存配置；404 `DASHBOARD_NOT_FOUND`（不在三实例内）。

---

## 6. 看板配置 dashboard JSON Schema

### 6.1 完整 Schema（draft-07）

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://statviz.local/schemas/v1/dashboard.schema.json",
  "title": "Dashboard",
  "type": "object",
  "required": ["dashboardId", "version", "title", "domain", "layout", "globalFilters", "cards", "charts"],
  "properties": {
    "dashboardId": { "type": "string", "pattern": "^dash-[a-z0-9-]+$" },
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "title": { "type": "string" },
    "domain": { "enum": ["cockpit", "macro", "tech"] },
    "layout": {
      "type": "object",
      "required": ["cols", "rowHeight"],
      "properties": {
        "cols": { "type": "integer", "const": 12 },
        "rowHeight": { "type": "number", "default": 64 },
        "note": { "type": "string", "description": "驾驶舱 顶20%卡带/中55%趋势分布/底25%排名预警 的分区提示" }
      }
    },
    "globalFilters": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "dim", "op", "label", "component", "default"],
        "properties": {
          "id": { "type": "string", "description": "如 gf-time / gf-region / gf-industry" },
          "dim": { "enum": ["time", "region", "industry"] },
          "op": { "enum": ["time_range", "in", "descendantOf"] },
          "label": { "type": "string" },
          "component": { "enum": ["month-range", "dim-tree", "dim-multi-select"] },
          "default": {
            "type": "object",
            "description": "初始值，结构同对应 leafFilter 的取值字段：{range:[..]} | {values:[..]} | {value:'..'}；缺省取最新月/全部"
          }
        }
      }
    },
    "cards": {
      "type": "array",
      "description": "指标卡带（驾驶舱 8 张 / 主题看板 6 张）",
      "items": {
        "type": "object",
        "required": ["cardId", "metric", "position"],
        "properties": {
          "cardId": { "type": "string", "pattern": "^card-[a-z0-9-]+$" },
          "metric": { "type": "string", "description": "单个指标编码" },
          "compare": { "type": "array", "items": { "enum": ["yoy", "mom"] }, "default": ["yoy"] },
          "timeMode": { "enum": ["latest", "range"], "default": "latest", "description": "latest=最新月单月卡" },
          "position": { "$ref": "#/definitions/position" }
        }
      }
    },
    "charts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["chartId", "type", "title", "position", "dataset", "drill", "emits", "subscribes"],
        "properties": {
          "chartId": { "type": "string", "pattern": "^c\\d+-[a-z0-9-]+$", "description": "如 c1-region-rank；联动事件 source 与 filter.sourceChartId 引用此值" },
          "type": { "enum": ["bar", "line", "pie", "table"] },
          "title": { "type": "string" },
          "position": { "$ref": "#/definitions/position" },
          "dataset": {
            "type": "object",
            "required": ["metrics", "dimensions", "time"],
            "description": "图表取数声明 = QueryRequest 子集（§2.1）+ 看板默认值；filters 为图表内置过滤（可含 sourceChartId 声明联动预置）",
            "properties": {
              "metrics": { "type": "array", "minItems": 1, "items": { "type": "string" } },
              "dimensions": { "type": "array", "items": { "$ref": "#/definitions/dimensionDeclDash" } },
              "filters": { "type": "array", "items": { "type": "object" } },
              "time": { "type": "object", "description": "含 grain/range/compare 默认值，如 {grain:'month', range:['2026-10','2026-10'], compare:['yoy']}" },
              "sort": { "type": "array", "items": { "type": "object" } },
              "limit": { "type": "integer", "default": 50 }
            }
          },
          "optionOverride": {
            "type": "object",
            "description": "ECharts option 深合并覆盖（如 series.label.show、颜色、双轴 yAxisIndex）；table 型为列定义 columns[]"
          },
          "drill": {
            "type": "object",
            "required": ["dims", "initialPath"],
            "properties": {
              "dims": { "type": "array", "items": { "enum": ["region", "industry"] }, "description": "该图允许的下钻维度" },
              "initialPath": {
                "type": "object",
                "description": "下钻初始路径：{维度: 节点编码或 ROOT}，如 {region:'ROOT'} 或 {region:'320000'}；编码会被 RLS 钳制到可见子树",
                "additionalProperties": { "type": "string" }
              },
              "maxDepth": { "type": "integer", "description": "P0 恒 2（两级）" }
            }
          },
          "emits": {
            "type": "array",
            "description": "本图作为联动源声明的事件；事件负载遵设计方案 §3.2 协议",
            "items": {
              "type": "object",
              "required": ["event", "dim"],
              "properties": {
                "event": { "enum": ["filter:click", "drill:nav"] },
                "dim": { "enum": ["region", "industry", "time"] },
                "op": { "enum": ["in", "descendantOf"], "default": "in" }
              }
            }
          },
          "subscribes": {
            "type": "array",
            "description": "本图作为联动目标订阅的维度与动作",
            "items": {
              "type": "object",
              "required": ["dim", "action"],
              "properties": {
                "dim": { "enum": ["region", "industry", "time"] },
                "action": { "enum": ["filter", "drill"], "description": "filter=注入 leafFilter(带 sourceChartId=源图)；drill=变更下钻状态" }
              }
            }
          },
          "dataSource": { "enum": ["query"], "default": "query" }
        }
      }
    }
  },
  "definitions": {
    "position": {
      "type": "object",
      "required": ["x", "y", "w", "h"],
      "properties": {
        "x": { "type": "integer", "minimum": 0, "maximum": 11 },
        "y": { "type": "integer", "minimum": 0 },
        "w": { "type": "integer", "minimum": 1, "maximum": 12 },
        "h": { "type": "integer", "minimum": 1 }
      }
    },
    "dimensionDeclDash": {
      "type": "object",
      "required": ["dim", "granularity"],
      "properties": {
        "dim": { "enum": ["region", "industry", "time"] },
        "granularity": { "enum": ["province", "city", "industry_c1", "industry_c2", "time_month"] }
      }
    }
  }
}
```

### 6.2 语义要点

1. **看板即 JSON**：`dash-macro` 与 `dash-tech` 是同一 Schema 的两个实例（PRD §5.2"同一模板换参数渲染"）；前端渲染器不 hardcode 任何指标/图表。
2. **dataset 与 /query 的关系**：dataset 是 QueryRequest 的**模板**——运行时前端合并 `全局筛选器值 + 用户下钻状态 + 订阅的 cross-filter（生成带 sourceChartId 的 leafFilter）` 后 POST /api/v1/query。图表自身不写 SQL、不写取数逻辑（US1）。
3. **drill.initialPath × RLS**：prov-js 打开 `{region:'ROOT'}` 的图，渲染器按 `/api/v1/meta/dims` 的可见根把 ROOT 钳制为 320000，granularity 由 province 自动落为 city（meta.rlsApplied 提示，D8）。
4. **emits/subscribes 与冲突矩阵**：点击图元 → 前端按 emits 声明广播事件；订阅图按 subscribes 合成 filter。同维度 last-wins、异维度 AND、全局筛选变更清空 cross-filter 栈——前端栈管理 + 服务端规范化消解（§2.2.4）双层一致，`meta.appliedFilters` 为断言点（D14/D15）。
5. **URL 终态**：`全局筛选 + 各图下钻状态 + 各图 cross-filter 栈` 压缩为短编码进查询参数（D12）；drill.initialPath 是还原缺省。
6. **cards 不参与联动**：指标卡只订阅全局筛选（时间/地区/行业），不订阅 cross-filter（避免卡片数字被单图点击误改）。

---

## 7. curl 请求/响应示例（对应 PRD §6 演示场景）

> 约定：正文含中文，建议 `--data-binary @file.json` 方式发送（先写临时文件，与 PRD 内网环境一致）。以下响应数值为演示种子预期（T02 黄金用例为准），仅示意结构。

### 7.1 场景一：全国 GDP 按省（驾驶舱 C 区排名，leader）

```bash
cat > /tmp/q1.json <<'EOF'
{
  "metrics": ["MACRO.GDP.VA0001", "MACRO.GDP.GR0001"],
  "dimensions": [{ "dim": "region", "granularity": "province" }],
  "time": { "grain": "month", "range": ["2026-10", "2026-10"], "compare": ["yoy"] },
  "sort": [{ "by": "MACRO.GDP.GR0001", "order": "desc" }],
  "limit": 50
}
EOF
curl -s -X POST http://127.0.0.1:3000/api/v1/query \
  -H "Content-Type: application/json" -H "X-Role: leader" --data-binary @/tmp/q1.json
```

响应（节选，江苏垫底标警的载体在 7.4）：

```json
{
  "data": [
    { "dims": { "region": { "code": "440000", "name": "广东省", "path": "/440000/" } },
      "metrics": {
        "MACRO.GDP.VA0001": { "value": 12893.4, "yoy": { "policy": "direct", "base": 12011.0, "delta": 882.4, "rate": 0.0735 } },
        "MACRO.GDP.GR0001": { "value": 6.1, "yoy": { "policy": "compare_then_compute", "base": 6.4, "delta": -0.3, "rate": null } } } },
    { "dims": { "region": { "code": "320000", "name": "江苏省", "path": "/320000/" } },
      "metrics": {
        "MACRO.GDP.VA0001": { "value": 10536.7, "yoy": { "policy": "direct", "base": 9812.3, "delta": 724.4, "rate": 0.0738 } },
        "MACRO.GDP.GR0001": { "value": 4.2, "yoy": { "policy": "compare_then_compute", "base": 5.9, "delta": -1.7, "rate": null } } } }
  ],
  "meta": { "cacheHit": false, "cacheKey": "9f13a0c2", "watermark": "wm-20261108-01", "metricDefVersion": "md-3",
    "dimTreeVersion": "dt-1", "elapsedMs": 18, "rlsRole": "leader", "rlsApplied": null, "appliedFilters": [],
    "sql": "SELECT region_prov AS dim_region, SUM(gdp_va) AS m1 FROM fact_macro WHERE month = '2026-10' GROUP BY region_prov",
    "rows": 31, "truncated": false }
}
```

### 7.2 场景二：江苏省内按市（下钻 descendantOf，J1 第 3 步）

```bash
cat > /tmp/q2.json <<'EOF'
{
  "metrics": ["MACRO.GDP.VA0001"],
  "dimensions": [{ "dim": "region", "granularity": "city" }],
  "filters": [{ "dim": "region", "op": "descendantOf", "value": "320000" }],
  "time": { "grain": "month", "range": ["2026-10", "2026-10"] },
  "sort": [{ "by": "MACRO.GDP.VA0001", "order": "desc" }],
  "limit": 50
}
EOF
curl -s -X POST http://127.0.0.1:3000/api/v1/query \
  -H "Content-Type: application/json" -H "X-Role: leader" --data-binary @/tmp/q2.json
```

```json
{
  "data": [
    { "dims": { "region": { "code": "320100", "name": "南京市", "path": "/320000/320100/" } },
      "metrics": { "MACRO.GDP.VA0001": { "value": 1721.5 } } },
    { "dims": { "region": { "code": "320500", "name": "苏州市", "path": "/320000/320500/" } },
      "metrics": { "MACRO.GDP.VA0001": { "value": 2103.8 } } }
  ],
  "meta": { "cacheHit": true, "cacheKey": "4b7de910", "watermark": "wm-20261108-01", "metricDefVersion": "md-3",
    "dimTreeVersion": "dt-1", "elapsedMs": 2, "rlsRole": "leader", "rlsApplied": null,
    "appliedFilters": [{ "dim": "region", "op": "descendantOf", "value": "320000", "status": "active" }],
    "sql": "SELECT region_city AS dim_region, SUM(gdp_va) AS m1 FROM fact_macro WHERE region_prov = '320000' AND month = '2026-10' GROUP BY region_city",
    "rows": 13, "truncated": false }
}
```

（prov-js 发同一请求：`rlsRole` 变 `prov-js`、`rlsApplied` 非 null、`cacheKey` 不同——D8/D10 断言点。）

### 7.3 场景三：制造业行业构成（联动 cross-filter，J1 第 4 步，D14/D15）

行业构成图被点击"制造业"后，市级排名图的重取数请求（sourceChartId 溯源 + 同维度 last-wins 演示）：

```bash
cat > /tmp/q3.json <<'EOF'
{
  "metrics": ["MACRO.GDP.VA0001"],
  "dimensions": [{ "dim": "industry", "granularity": "industry_c2" }],
  "filters": [
    { "dim": "region", "op": "descendantOf", "value": "320000" },
    { "dim": "industry", "op": "in", "values": ["F"], "sourceChartId": "c2-industry-mix" },
    { "dim": "industry", "op": "in", "values": ["C"], "sourceChartId": "c2-industry-mix" }
  ],
  "time": { "grain": "month", "range": ["2026-10", "2026-10"] },
  "sort": [{ "by": "MACRO.GDP.VA0001", "order": "desc" }],
  "limit": 50
}
EOF
curl -s -X POST http://127.0.0.1:3000/api/v1/query \
  -H "Content-Type: application/json" -H "X-Role: leader" --data-binary @/tmp/q3.json
```

```json
{
  "data": [
    { "dims": { "industry": { "code": "C35", "name": "专用设备制造业", "path": "/C/C35/" } },
      "metrics": { "MACRO.GDP.VA0001": { "value": 386.2 } } },
    { "dims": { "industry": { "code": "C39", "name": "计算机通信电子设备制造业", "path": "/C/C39/" } },
      "metrics": { "MACRO.GDP.VA0001": { "value": 512.7 } } }
  ],
  "meta": { "cacheHit": false, "cacheKey": "77c01e5a", "watermark": "wm-20261108-01", "metricDefVersion": "md-3",
    "dimTreeVersion": "dt-1", "elapsedMs": 11, "rlsRole": "leader", "rlsApplied": null,
    "appliedFilters": [
      { "dim": "region", "op": "descendantOf", "value": "320000", "status": "active" },
      { "dim": "industry", "op": "in", "values": ["F"], "sourceChartId": "c2-industry-mix", "status": "superseded" },
      { "dim": "industry", "op": "in", "values": ["C"], "sourceChartId": "c2-industry-mix", "status": "active" }
    ],
    "sql": "SELECT ind_c2 AS dim_industry, SUM(gdp_va) AS m1 FROM fact_macro WHERE region_prov = '320000' AND ind_c1 = 'C' AND month = '2026-10' GROUP BY ind_c2",
    "rows": 8, "truncated": false }
}
```

> 断言点：`appliedFilters` 中 F 为 `superseded`、C 为 `active`（last-wins，非并集，D15①）；SQL 只含 `ind_c1 = 'C'`；结果不含非制造业大类（D14）。

### 7.4 场景四：江苏规上工业同比异常定位（J1 第 2/5 步，D3 异常叙事）

```bash
cat > /tmp/q4.json <<'EOF'
{
  "metrics": ["MACRO.IND.VA0002"],
  "dimensions": [{ "dim": "region", "granularity": "province" }],
  "filters": [{ "dim": "region", "op": "in", "values": ["320000", "440000", "510000"] }],
  "time": { "grain": "month", "range": ["2026-09", "2026-10"], "compare": ["yoy", "mom"] },
  "sort": [{ "by": "MACRO.IND.VA0002", "order": "desc" }],
  "limit": 10
}
EOF
curl -s -X POST http://127.0.0.1:3000/api/v1/query \
  -H "Content-Type: application/json" -H "X-Role: leader" --data-binary @/tmp/q4.json
```

```json
{
  "data": [
    { "dims": { "region": { "code": "320000", "name": "江苏省", "path": "/320000/" } },
      "metrics": { "MACRO.IND.VA0002": {
        "value": 4612.9,
        "yoy": { "policy": "direct", "base": 4891.7, "delta": -278.8, "rate": -0.057 },
        "mom":  { "policy": "direct", "base": 4855.0, "delta": -242.1, "rate": -0.0499 } } } }
  ],
  "meta": { "cacheHit": false, "cacheKey": "e2a90ff3", "watermark": "wm-20261108-01", "metricDefVersion": "md-3",
    "dimTreeVersion": "dt-1", "elapsedMs": 9, "rlsRole": "leader", "rlsApplied": null,
    "appliedFilters": [{ "dim": "region", "op": "in", "values": ["320000", "440000", "510000"], "status": "active" }],
    "sql": "SELECT region_prov AS dim_region, month AS dim_time, SUM(ind_va) AS m1 FROM fact_macro WHERE region_prov IN ('320000','440000','510000') AND month BETWEEN '2026-09' AND '2026-10' GROUP BY region_prov, month",
    "rows": 3, "truncated": false }
}
```

> 江苏当月同比转负（delta/rate 为负，全国唯一），驱动 D 区预警行与第 3 步下钻；演示数据预埋见 PRD §6。若把 metrics 换成 `["MACRO.INV.CU0004"]` 且 compare 含 `mom`，返回见 7.6。

### 7.5 meta 端点示例

```bash
# 指标字典：搜"能耗"（D16 加演 4）
curl -s http://127.0.0.1:3000/api/v1/meta/metrics?q=能耗 -H "X-Role: leader"
# → { "data": [ { "code": "MACRO.ENGI.GR0009", "polarity": "inverse", "...": "§3.2" } ], "meta": { "count": 16, "filtered": 1, "...": "..." } }

# 维度树：prov-js 拉江苏子树（D8；请求 parent=440000 则 data:[]）
curl -s "http://127.0.0.1:3000/api/v1/meta/dims?dim=region&parent=320000" -H "X-Role: prov-js"
# → { "data": [ { "code": "320100", "name": "南京市", "path": "/320000/320100/", "level": 2, "isLeaf": true }, "..." ], "meta": { "count": 13, "...": "..." } }

# 看板配置：宏观主题看板
curl -s http://127.0.0.1:3000/api/v1/meta/dashboard/dash-macro -H "X-Role: leader"
# → { "data": { "dashboardId": "dash-macro", "charts": [ { "chartId": "c2-industry-mix", "emits": [ { "event": "filter:click", "dim": "industry" } ], "..." : "..." } ], "...": "..." }, "meta": { "version": "1.0.0", "etag": "cfg-7f2a" } }
```

### 7.6 错误路径示例（DoD 断言用）

**D2 未注册编码（404）**：

```bash
cat > /tmp/e1.json <<'EOF'
{ "metrics": ["MACRO.GDP.XX9999"], "time": { "grain": "month", "range": ["2026-10", "2026-10"] } }
EOF
curl -s -X POST http://127.0.0.1:3000/api/v1/query \
  -H "Content-Type: application/json" -H "X-Role: leader" --data-binary @/tmp/e1.json
# → HTTP 404
# { "error": { "code": "METRIC_NOT_FOUND", "message": "指标编码未注册：MACRO.GDP.XX9999",
#     "detail": { "metric": "MACRO.GDP.XX9999", "registeredCount": 16 }, "traceId": "t-..." } }
```

**D4 累计指标请求环比（403）**：

```bash
cat > /tmp/e2.json <<'EOF'
{ "metrics": ["MACRO.INV.CU0004"], "time": { "grain": "month", "range": ["2026-10", "2026-10"], "compare": ["mom"] } }
EOF
curl -s -X POST http://127.0.0.1:3000/api/v1/query \
  -H "Content-Type: application/json" -H "X-Role: leader" --data-binary @/tmp/e2.json
# → HTTP 403
# { "error": { "code": "COMPARE_POLICY_FORBIDDEN", "message": "累计型指标禁用环比，仅接受同比",
#     "detail": { "metric": "MACRO.INV.CU0004", "policy": "cumulative", "requested": "mom" }, "traceId": "t-..." } }
```

**D7 越权查询返回空集（200，非 403）**：

```bash
cat > /tmp/e3.json <<'EOF'
{ "metrics": ["MACRO.GDP.VA0001"], "dimensions": [{ "dim": "region", "granularity": "city" }],
  "filters": [{ "dim": "region", "op": "descendantOf", "value": "440000" }],
  "time": { "grain": "month", "range": ["2026-10", "2026-10"] } }
EOF
curl -s -X POST http://127.0.0.1:3000/api/v1/query \
  -H "Content-Type: application/json" -H "X-Role: prov-js" --data-binary @/tmp/e3.json
# → HTTP 200
# { "data": [], "meta": { "cacheHit": false, "rlsRole": "prov-js",
#     "rlsApplied": { "dim": "region", "predicate": "path LIKE '/320000/%'", "scopePath": "/320000/", "visibleRoot": "320000" },
#     "appliedFilters": [{ "dim": "region", "op": "descendantOf", "value": "440000", "status": "active" }], "rows": 0, "...": "..." } }
```

**D9 伪造授权参数被剥离（200，与不带该字段逐字节一致）**：

```bash
cat > /tmp/e4.json <<'EOF'
{ "metrics": ["MACRO.GDP.VA0001"], "time": { "grain": "month", "range": ["2026-10", "2026-10"] },
  "rls": "role:leader", "forceRegion": "/440000/" }
EOF
curl -s -X POST http://127.0.0.1:3000/api/v1/query \
  -H "Content-Type: application/json" -H "X-Role: prov-js" --data-binary @/tmp/e4.json
# → HTTP 200，本省口径单行（与无 rls/forceRegion 字段时响应逐字节一致；剥离行为记审计日志）
```

---

## 8. DoD 覆盖矩阵（契约条款 ↔ PRD §3 验收）

| DoD | 验证要点 | 本契约支撑条款 |
|-----|---------|----------------|
| D1 | 编译结果=基准 SQL、无 JOIN | §2.2.2 维度→列映射；`meta.sql`（§2.3）；单事实表约束（§2.2.1） |
| D2 | 未注册编码/裸 SQL → 4xx | §2.1 metrics pattern；错误码表 `METRIC_NOT_FOUND`/`DSL_SCHEMA_INVALID`（§2.4.2）；§7.6 示例 |
| D3 | 比值型先比分母分母再算差 | §2.5 compare_then_compute 算法与数值示例；`yoy.policy` 回显 |
| D4 | 累计型 mom 被拒（4xx） | §2.5 冲突行为；403 `COMPARE_POLICY_FORBIDDEN`（§7.6）；`allowedCompares`（§3.2）驱动 UI 置灰 |
| D5 | 逆指标警示语义 | `polarity` 结构化字段（§3.2）；数值与展示职责分离（§2.5 末段） |
| D6 | 下钻与同环比正交 | §2.5"时间子句原样传递"；§7.4 示例 |
| D7 | 越权→200 空集 | §2.6.2 行级越权规则；§7.6 示例；`FORBIDDEN_BY_RLS` 边界（§2.4.2） |
| D8 | prov-js 全裁剪 | `meta.rlsApplied`（§2.6.3）；/meta/dims 裁剪（§4）；§6.2-3 RLS 钳制 |
| D9 | 伪造授权参数被忽略 | §2.1 附注剥离策略；§7.6 示例 |
| D10 | 缓存命中/角色分键 | §2.7 键公式含 role；`meta.cacheHit/cacheKey` |
| D11 | 三 bump 即失效 | §2.7 失效事件三版本因子 |
| D12 | URL 还原终态 | §6.2-5 URL 终态编码；dataset 模板 + 状态合并 |
| D13 | 三入口同事件 | emits/drill 声明（§6.1）；事件协议沿用设计方案 §3.2 |
| D14 | 联动重取数仅含制造业 | `sourceChartId`（§2.2.4）；§7.3 示例断言 |
| D15 | last-wins/AND/清栈 | §2.2.4 规范化消解 + `appliedFilters` 回显；§7.3 |
| D16 | 元数据驱动渲染 | §3 /meta/metrics 全结构化字段；§5 /meta/dashboard |
| D17 | 三页面可载入 | §3/§4/§5 三 meta 端点 + /query 完整闭环；空态走 `rows:0` |

---

## 9. 变更控制

- 本契约对应 PRD §2.6：DSL 表达力不足时允许修契约，但必须同步黄金用例集（T02）并全量回归，双侧同步（风险 R5）。
- 生产迁移（PRD §4.3）：Schema、编译语义、错误码、缓存键四因子原样迁 Spring Boot/Cube；X-Role 换统一鉴权、内存缓存换 Redis，注入点与键算法不变。

> 本文档冻结字段见 §0 命名规范表；T02 黄金 SQL 以 `meta.sql` 产物比对为准。


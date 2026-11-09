# T05 · 语义层服务（零依赖 Node）

统计数据可视表平台 MVP 的取数后端：DSL 校验 → RLS 注入 → 内存聚合 → 同环比 → 缓存。
仅使用 Node 内置模块（`http/fs/path/crypto`），无任何第三方依赖。
契约依据：`docs/mvp/03-DSL与API契约.md`（字段命名、错误码、缓存键、RLS、同环比规则均以契约为准）。

## 启动

```bash
node D:\local\visual\mvp\server\index.js          # 默认端口 3000
node D:\local\visual\mvp\server\index.js 3001     # 指定端口
```

自测（随机端口启动服务并断言，全过退出码 0）：

```bash
node D:\local\visual\mvp\server\smoke.js
```

## 端点摘要

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/query` | 查询主端点。请求头 `X-Role: leader \| prov-js \| prov-gd`（缺失/非法 → 401）。按契约 §2.1 QueryRequest Schema 校验，响应 `data[] + meta`（cacheHit/cacheKey/rlsApplied/appliedFilters/sql/rows/truncated） |
| POST | `/api/v1/admin/watermark` | bump 版本因子使缓存失效（D11）。body 可选 `{"factor":"watermark"\|"metricDef"\|"dimTree"}`，默认 watermark。换键 + 清空缓存，TTL 300s 仅兜底 |
| GET | `/api/v1/meta/metrics` | 指标字典（元数据驱动渲染源）。过滤参数 `domain/q/agg_type/compare_policy/polarity`；返回结构化 `aggType/comparePolicy/polarity/allowedCompares` |
| GET | `/api/v1/meta/dims` | 维度树（RLS 裁剪）。参数 `dim=region\|industry&parent=&depth=1\|2`；prov-* 根自动改写为本省，越界 parent → 200 空集 |
| GET | `/api/v1/meta/dashboard/:id` | 看板配置原样下发。优先读 `mvp/data/dashboards.json`；文件不存在时使用代码内置默认配置（`dash-cockpit` 驾驶舱 + `dash-macro` 主题看板，**待 T07 替换**） |
| GET | `/`、`/assets/*` 等 | 静态服务 `../web`（index.html/app.js/style.css/assets/echarts.min.js），正确 MIME + charset=utf-8 |

## 实现要点

- **数据加载**：启动时把 `../data/{metrics,dims,facts,roles}.json` 读入内存（4840 事实行）。
- **聚合**：事实按 市×大类×月 叶子粒度存储；省/门类值由叶子上卷全派生。sum=Σ；ratio=Σ分子/Σ分母现算；cumulative/snapshot 时间不可加、折叠窗口末月。
- **RLS**：`X-Role` → 绑定机构节点 path 前缀谓词，编译期注入；请求体任何授权类字段（`rls/role/forceRegion` 等）在规范化阶段剥离（D9）；行级越权 → 200 空集（D7）。
- **同环比**（契约 §2.5）：`direct` 直接比；`compare_then_compute` 先分别聚合分子分母同期再算比值（delta=pct 点差、rate=null）；`cumulative` 禁 mom；`snapshot` 仅 yoy；`window_sum` 预留分支。种子字典策略 `window_sum/none` 自动映射为契约策略 `direct/cumulative/snapshot`。基期窗口不在事实数据窗（2025-01 前）时该比较子对象缺省（空同比）。
- **缓存**：`sha256("v1"|role|canonicalDSL|watermark|metricDefVersion|dimTreeVersion)`；canonicalDSL 已剥离未知字段/sourceChartId/superseded 叶子；`meta.cacheKey` 为 sha256 前 8 位。
- **过滤消解**：纯 AND 上下文同 dim 值叶子（in/descendantOf）last-wins，被覆盖叶子回显 `status:"superseded"`（D15），SQL 无 JOIN（D1）。
- **错误结构**：`{error:{code,message,detail,traceId}}`；错误码与 HTTP 状态按契约 §2.4.2（DSL_SCHEMA_INVALID / METRIC_NOT_FOUND / DIM_MISMATCH / BAD_FILTER / INVALID_TIME_RANGE / COMPARE_POLICY_FORBIDDEN / UNAUTHENTICATED / DASHBOARD_NOT_FOUND / INTERNAL）。
- **审计**：每请求内存记录（角色、规范化 DSL、剥离字段、缓存命中、编译 SQL，环形 500 条）。

## curl 示例

```bash
# 全国 GDP 按省（含同比）
curl -s -X POST http://127.0.0.1:3000/api/v1/query -H "Content-Type: application/json" -H "X-Role: leader" \
  --data-binary @- <<'EOF'
{"metrics":["MACRO.GDP.VA0001","MACRO.GDP.GR0001"],
 "dimensions":[{"dim":"region","granularity":"province"}],
 "time":{"grain":"month","range":["2026-10","2026-10"],"compare":["yoy"]}}
EOF

# bump 水位 → 缓存失效
curl -s -X POST http://127.0.0.1:3000/api/v1/admin/watermark

# 指标字典（搜"能耗"）/ 维度树（江苏子树，prov-js）/ 看板配置
curl -s "http://127.0.0.1:3000/api/v1/meta/metrics?q=能耗" -H "X-Role: leader"
curl -s "http://127.0.0.1:3000/api/v1/meta/dims?dim=region&parent=320000" -H "X-Role: prov-js"
curl -s http://127.0.0.1:3000/api/v1/meta/dashboard/dash-cockpit -H "X-Role: leader"
```

## 文件清单

- `index.js` —— 服务实现（直跑入口 + `startServer()` 供复用）
- `smoke.js` —— 自测脚本（10 组断言：手工上卷对账、D3 比值算法、D4 禁环比、D8 裁剪、D10/D11 缓存、D2 未注册、D15 last-wins、D7 越权空集、D9 剥离、静态 MIME/无 JOIN/401）
- `README.md` —— 本文件

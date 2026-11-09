# Changelog

本项目所有显著变更将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [0.1.1] - 2026-11-09

### Added

- **CI/CD 流水线**：GitHub Actions 双工作流——`ci.yml`（Node 18/20/22 矩阵：语法检查 + 49 条契约测试 + 体验站 6 组黄金对账 + 产品代码零 shell-exec 自检）；`release.yml`（打 `v*` 标签自动跑测试 → 打包静态体验站 zip → 创建 GitHub Release 并附资产）。
- **`package.json`**：项目清单与统一脚本（`npm start / test / smoke / test:demo / dashboard`），声明 Node ≥18 引擎要求。
- **开源发布链路**：GitHub 公开仓库 + 中文简介 + 20 个关键词（topics）+ GitHub Pages 公网体验站（`/docs` 源）。

### Security

- **静态资源路径穿越五重加固**（`mvp/server/index.js` serveStatic）：
  ① `decodeURIComponent` 解码后再校验，拒绝非法编码变体；
  ② 拒绝 `.` / `..` 路径段（同时识别 `\` 与 `/`，挡住 `..%5c` Windows 变体）；
  ③ `path.resolve` 后做根目录边界校验；
  ④ 扩展名白名单（html/js/css/json/svg/png/ico/woff/map），拒绝读取源码与配置；
  ⑤ `fs.realpath` 二次校验，挡住符号链接逃逸。
  实测 `/../../etc/passwd`、`/..%5cserver%5cindex.js` 等均被拒（403/404），正常资源不受影响。
- **新增 4 个安全响应头**：`Content-Security-Policy`（default-src 'self'、object-src 'none'、frame-ancestors 'none'）、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`。
  即使发生注入，脚本也无法外连或加载第三方资源。

### Fixed

- **消除动态 require 模式**：`require(path.join(__dirname, '..', 'data', 'facts.json'))` 改为静态字面量 `require('../data/facts.json')`，语义等价，消除静态扫描器将其归类为"动态代码执行/命令注入"的误报触发面（smoke.js / tests.js 同步整改）。
- **修复指标字典页"允许比较"恒空 bug**：`app.js` 中三元运算符优先级错误（`(A + B) ? '' : '…'` 恒取真分支）导致该栏永远渲染为空；修正括号后恢复正常显示"同比 / 环比（禁环比，入口不渲染）"。

### Security 扫描状态

- mimosa 初扫 **5 项（3 高危）→ 复扫 1 项（0 高危 / 1 中危）**，门禁红 → 黄。
  剩余 1 项中危经人工核查为转义误报（远端字段均经 `esc()` 转义，CSP 纵深防御兜底），已登记跟踪，v0.2 生产化时引入 DOMPurify 白名单渲染。详见 [`docs/mvp/08-安全修复报告.md`](docs/mvp/08-安全修复报告.md)。

## [0.1.0] - 2026-11-09

MVP 首版：指标先行的统计数据多维可视表平台技术验证原型。

### Added

#### 语义层服务（`mvp/server/index.js`，零依赖 Node，端口 3000）

- DSL 校验 → RLS 编译期注入 → 内存聚合 → 同环比计算 → 结果缓存 五段流水线，仅用 Node 内置模块（http/fs/path/crypto）。
- 七端点：`POST /api/v1/query`（查询主端点）、`POST /api/v1/admin/watermark`（版本水位 bump，缓存即时失效）、`GET /api/v1/meta/metrics`（指标字典）、`GET /api/v1/meta/dims`（维度树 RLS 裁剪）、`GET /api/v1/meta/dashboard/:id`（看板配置下发）+ 静态资源服务；统一错误结构与 traceId。
- 层级冗余列设计：事实按 市×大类×月 叶子粒度存储，省/门类上卷全派生，下钻查询零 JOIN。
- 三角色 RLS（`leader` / `prov-js` / `prov-gd`）：请求头编译期注入 path 前缀谓词，授权类字段规范化阶段剥离，越权返回 200 空集。
- 同环比策略由指标元数据声明（`agg_type` + `compare_policy`）：直接比 / 先比子项再算比值 / 累计禁环比 / 快照仅同比。
- 缓存键 = sha256(角色 × 规范化 DSL × 数据水位 × 字典版本)，同维过滤 last-wins 消解并回显 superseded。

#### 前端三页（`mvp/web/`，零构建 vanilla JS + 本地 ECharts，离线可演示）

- 领导驾驶舱 `#/cockpit`：8 指标卡、GDP 当月柱 + 累计同比线双轴趋势、省域增速排名（垫底标红、点击下钻）、异常预警区、主题速通入口。
- 主题看板 `#/theme/macro`（及 `#/theme/tech`）：全局筛选带、行业构成环形图单击联动、行业门类/大类柱线趋势、省域/市级明细表（行下钻、右键逐月明细）、维度树侧栏。
- 指标字典 `#/dict`：16 指标全字段检索与 facet 侧栏（主题域 / agg_type / compare_policy / polarity），口径公式、分子分母引用、逆指标警示。
- URL 即终态：下钻、联动、明细抽屉全部压缩进查询参数，复制 URL 新开标签完整还原。

#### 种子数据（`mvp/data/`）

- 16 个指标、4840 行确定性算法生成的种子事实数据（虚构演示数据，非真实统计数字），3 组预埋异常。
- 地区 5 省（江苏/广东/浙江/山东/贵州）部分市、行业 3 门类 10 大类、时间窗 2025-01～2026-10 共 22 个月。
- 指标/维度/事实/角色/看板五个 JSON，启动时内存加载；`tools/gen-facts.js` 为生成器。

#### 多智能体作战指挥台（`dashboard/`，端口 8787）

- SSE 实时任务看板，多智能体协同构建本项目的"作战指挥台"：任务分派、进度上报、实时事件流。

#### 测试与质量

- `mvp/server/tests.js`：DoD 逐项功能测试套件，49 条自动断言（期望值独立按种子数据复算，不复用服务端聚合代码路径）。
- `mvp/server/smoke.js`：冒烟自测，随机端口自启自停。
- DoD D1–D17 全部通过（17/17）；API 压测热 P95 1 ms / 1328 rps。
- mimosa 安全扫描闭环（初扫 5 项 → 高危清零），见 v0.1.1 修复记录。

#### 文档（`docs/`）

- `docs/统计数据可视表平台设计方案.md`：v1.0 总体设计方案（生产架构蓝本）。
- `docs/mvp/01-PRD.md`：产品需求与 DoD D1–D17、不做清单。
- `docs/mvp/02-数据字典与种子数据.md`：16 指标口径与种子生成规则。
- `docs/mvp/03-DSL与API契约.md`：唯一取数契约。
- `docs/mvp/04-UI交互规范.md`：三页面交互与视觉规范。
- `docs/mvp/05-测试报告.md`：测试验收记录。
- `docs/mvp/06-走查与修复.md`：走查问题与修复闭环。
- `docs/mvp/07-安全扫描报告.md`：mimosa 初扫报告。

[0.1.1]: https://github.com/<your-org>/statvista/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/<your-org>/statvista/releases/tag/v0.1.0

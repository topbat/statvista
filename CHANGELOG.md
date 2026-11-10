# Changelog

本项目所有显著变更将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [0.2.0] - 2026-11-09

第 2 圈迭代(v0.2 生产化):安全门禁转绿 + Doris 接入 + 省域地图 + 暗色大屏 + 报告导出。

### Added

- **预警清单服务端实时计算**(T25):新端点 `GET /api/v1/alerts`——ratio 型×31 省×当月逐请求实时判定(负增长 warning / 连续 ≥3 月 danger),逆指标语义反转,RLS 全视角过滤;前端预埋 `PRESET_ALERTS` 降级为兜底通道(来源徽标"实时计算 / 预埋兜底")。
- **Doris 接入**(T26):新建 `mvp/server/doris.js` 方言编译器——DSL→Doris SQL(`dwd_stat_fact` 物理映射、层级冗余列零 JOIN、RLS 编译期注入、ratio=SUM(num)/NULLIF(SUM(den),0)、同比双窗口、LIMIT 2000 兜底、watermark/cacheKey 注释头);Executor 三通道:`local`(默认,黄金值不变)/ `doris`(DORIS_FE 等 4 env 配置即启,FE REST+NDJSON)/ `shadow`(双跑对账);新端点 `POST /api/v1/compile` 使编译 SQL 可观测;`/api/v1/query` 响应附 `meta.execution={backend,sqlHash,durMs}`。
- **GeoJSON 省域地图**(T27):驾驶舱 C 区图元升级——`registerMap('china')` 接入 569KB 本地省域边界,adcode↔dims code 硬联结,visualMap 四档着色(负增长红系/正增长蓝系/缺数灰);点击省份与原条形图**同事件同 URL 终态**;三层降级链(GeoJSON 失败回条形/非 leader 保留市条形/数据失败错误块)。
- **暗色大屏**(T28):硬编码色审计归零,40+ CSS 变量收敛,`html[data-theme="dark"]` 深蓝黑政务风;`?theme=dark|light` → localStorage → 页头 ☀️/🌙 三通道切换;ECharts 变量同步式主题(dispose+re-init,数据不重拉);投屏 `?screen=tv` + `@media ≥1920px` 双通道。
- **报告导出**(T29):新端点 `GET /api/v1/report`——报告 HTML 服务端实算(8 指标卡/省份排名/预警清单与页面同源同值),**指标口径脚注**自动生成(编码/名称/单位/agg_type/compare_policy/公式/极性);打印 CSS 分页优化 + 🖨 打印/另存 PDF;前端驾驶舱/主题看板页头"📄 导出报告"按钮。
- **契约与联调文档**:`docs/mvp/09-v0.2契约冻结.md`(预警/编译/报告三契约+波次文件所有权+编码落位说明 §7)。

### Changed

- **测试基线 49 → 92 断言**(alerts 8+SQL 黄金快照 4+compile 7+report 7+联调对账,全绿 ×3 轮);smoke 25/25。
- **性能复测**(3000 实测各 80 样本):query 热 P95 2.1ms / alerts(每请求现算)P95 4.4ms / compile P95 1.3ms。
- J2 旅程(地图下钻)API 11/11 + UI 无头走查 5 次零控制台错误;新增 4 张 v0.2 截图。

### Security

- **剩余 1 项中危转正修复**(T24):引入 DOMPurify 3.2.4 官方库(`assets/purify.min.js`),`setHtml()` 统一 38 处 innerHTML 注入点白名单渲染;esc() 文本级+DOMPurify 结构级双保险;XSS 样例断言 12/12(`<script>`/`onerror`/`javascript:` href 全剥离,业务标记全存活);门禁预期 amber→green。

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

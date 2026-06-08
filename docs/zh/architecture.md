# 架构总览

> 状态：持续维护的活文档。这是面向贡献者的高层次导览。
> 权威且详细的设计见
> [`.kiro/specs/prediction-market-aggregator/design.md`](../../.kiro/specs/prediction-market-aggregator/design.md)（英文）。
> 英文版本：[`docs/architecture.md`](../architecture.md)。

## 这是什么

预测市场聚合器是一个独立的、**只读**的对比看板与数据服务。它把多个平台（v1：
Polymarket 与 Manifold）的预测市场统一进同一套规范化数据模型，让用户可以：

- 在跨平台范围内搜索同一个真实世界问题，
- 并排比较隐含概率，以及
- 把跨平台最大价差作为**仅供展示**的信号查看。

v1 刻意止步于任何受监管的行为：**不下单、不路由资金、不执行交易**。「去交易」动作只是
一个跳转到来源平台的深链接。架构为未来的「一键参与」流程预留了这个插槽，接入时无需重写。

## 分层架构

依赖方向指向内部的核心领域。适配器层与 API 网关是可替换的边缘。

```
可替换边缘                核心领域                      基础设施
-----------              --------                      --------
适配器层    ───────▶  摄取编排器（Ingestion）
（按平台）             规范化模型      ────────▶        Postgres + TimescaleDB
API 网关    ───────▶  匹配引擎                          Redis
（REST/WS）           告警引擎                          搜索（Postgres FTS）
```

**依赖规则：** `adapters/*` 与 `api/` 依赖 `core/`；`core/` 不依赖任何外部东西。这保证了
领域层的纯净，也使「接入一个平台」成为局部改动（只在 `adapters/` 下新增一个目录）。

## 模块 / 仓库结构

```text
prediction-market-aggregator/
├── packages/
│   ├── core/        # 规范化领域模型、类型、值对象（无 I/O）
│   │   ├── src/model/    # Source、Event、Market、Outcome、PricePoint、CanonicalEvent
│   │   ├── src/ports/    # MarketSource 接口 + 仓储接口
│   │   └── src/services/ # 领域服务（价差计算、规范化辅助）
│   ├── adapters/    # 每个平台一个目录；只依赖 core/ports
│   │   ├── polymarket/
│   │   └── manifold/
│   ├── ingestion/   # 编排器、调度器、轮询器、WS 管理、幂等写入
│   ├── matching/    # 同一问题匹配引擎（规则 → 嵌入 → 校准）
│   ├── storage/     # Postgres/TimescaleDB 仓储、Redis 缓存、迁移
│   ├── api/         # REST + GraphQL + WebSocket 扇出网关
│   └── alerts/      # 关注列表 + 价格异动告警引擎
├── apps/
│   └── web/         # Next.js 前端（Recharts / lightweight-charts）
├── docs/            # 架构文档、适配器开发指南、数据模型
└── docker-compose.yml # Postgres+TimescaleDB、Redis（本地开发）
```

## 核心组件

| 组件                           | 包           | 职责                                                                                              |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------- |
| 适配器层（`MarketSource`）     | `adapters/*` | 把每个平台特有的关注点（鉴权、端点、分页、限流、载荷形状、WS 协议）隔离到一个统一接口背后。        |
| 摄取流水线（Ingestion）        | `ingestion`  | 跨适配器编排轮询 + 流式订阅，幂等写入，在上游故障下保持健壮。                                      |
| 同一问题匹配引擎               | `matching`   | 把代表同一真实世界问题的市场分组到一个 `CanonicalEvent`；标记结算口径不一致的情况。                |
| 存储层                         | `storage`    | Postgres 关系型元数据、TimescaleDB `price_point` 超表、Redis 热缓存 + 发布/订阅。                  |
| 对外 API 网关                  | `api`        | 系统自己的 REST/GraphQL + WebSocket 扇出，客户端唯一使用的接口。                                   |
| 告警 / 关注列表服务            | `alerts`     | 跟踪市场/规范事件；在阈值穿越与价差扩大时通知用户。                                                |

## 数据流（概要）

1. **元数据摄取** — 编排器（`syncMarkets`）以 keyset 分页轮询每个适配器，规范化 + 校验
   载荷，并以 `(source_id, external_id)` 为键做幂等 upsert。健壮的取数包装器（`withRetry`）
   按来源做令牌桶限流和带抖动的指数退避；游标只有在某页被持久化写入后才前进，且在失败时绝不回退。
2. **价格流式** — `classifyTier` 把市场分为活跃（active）与长尾（long-tail）。活跃市场在
   适配器声明 `websocketPrices` 时走 WebSocket；长尾市场以更慢的节奏轮询。`onTick` 会更新
   Redis 热缓存、向 TimescaleDB 超表追加（以 `(market_id, outcome_id, ts)` 幂等），并发布到
   扇出。WebSocket 断开时，管理器以退避方式重连，并通过 `fetchPriceHistory` 回填缺口，确保
   曲线没有空洞。
3. **同一问题匹配** — 新增/更新的市场经过分层匹配器（规则 → 语义相似 → 校准 → 结算口径对齐）。
   结算口径不一致的会被标记并从信号中排除。
4. **服务对外** — API 网关以 REST 提供发现、对比、详情与仅供展示的信号，并通过自己的
   WebSocket 扇出推送实时更新。前端只与该网关通信。

数据模型（实体、表、幂等键、索引、校验规则）见 [`data-model.md`](./data-model.md)。

## 匹配引擎各层

同一问题匹配引擎（`packages/matching`）由易到难分层；每一层为下一层缩小候选集。第 4 层在
任何一对市场参与价差信号之前都是强制的。

| 层 | 做什么                                                                                                  | 模块                    |
| -- | ------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1  | 规则/元数据预筛：类别、时间窗口、主体实体（subject entity）与阈值（threshold）抽取。                     | `layer1-prefilter.ts`   |
| 2  | 语义相似：与具体提供方无关的嵌入（embedding）+ 按可配置阈值的余弦相似度打分。                            | `layer2-similarity.ts`  |
| 3  | 校准门：低于阈值/高价值的配对进入人工校准队列；决策作为带标签数据持久化（`match_label`）。               | `layer3-calibration.ts` |
| 4  | 结算口径对齐：比较数据来源、截止时间（带容差）、舍入规则；实质性分歧 → `resolutionMismatch = true`。     | `layer4-alignment.ts`   |

随后 `computeSignals`（`signals.ts`）只在**开放且未标记不一致**的市场之间，按跨平台最大隐含
概率价差对规范事件排序，并把每个信号标记为 `executable: false`（仅供展示，需求 3.3）。

## API 接口

对外网关（`packages/api`，基于 Fastify）是客户端唯一使用的接口。所有上游差异都在这里被屏蔽，
限流也在此统一（需求 9.1）。

```text
GET  /api/markets                  发现（按 category / q / status 筛选、排序）
GET  /api/markets/:id              详情（元数据 + 结果项 + 最新价）
GET  /api/markets/:id/history      价格历史时间序列（range、interval）
GET  /api/markets/:id/trade-link   对外来源深链接（仅跳转）
GET  /api/sources                  已注册平台 + 能力
GET  /api/canonical-events         跨平台分组（可选 category）
GET  /api/canonical-events/:id     同一问题对比视图（含不一致标记）
GET  /api/signals                  仅供展示的价差信号（按价差排序）
GET  /healthz                      存活探针

# 用户维度，需要鉴权（仅在注入存储时挂载）：
GET    /api/watchlist              POST /api/watchlist     DELETE /api/watchlist/:itemId
GET    /api/alerts                 POST /api/alerts        DELETE /api/alerts/:alertId

WS  /ws                            由 Redis 发布/订阅驱动的扇出（market/canonical/alerts）
```

热路径上的最新价从 Redis 热缓存提供。trade-link 端点返回 `{ url, executable: false }`，是
可替换的未来「一键参与」插槽（见
[`compliance-and-future-seams.md`](./compliance-and-future-seams.md)）。

### WebSocket 扇出

`WS /ws` 暴露 `market`、`canonical`、`alerts` 三类频道。它由摄取的 `onTick` 路径（以及告警
引擎）通过 Redis 发布/订阅驱动，因此客户端能拿到实时价格/价差/告警更新，而**无需**连接任何上游
平台（需求 9.2）。仅在注入了 Redis 订阅者工厂时挂载该路由。

### 网关加固（鉴权 + 限流）

- **统一限流**（需求 9.3）：通过 `@fastify/rate-limit` 设置一个全局的按客户端（IP）策略，
  统一作用于每个公共只读端点；超限返回 `429`，并带标准的 `x-ratelimit-*` / `retry-after` 头。
  存活探针不参与限流。
- **输入校验**（需求 9.3）：每个端点在边缘用纯函数解析其 query/path 参数；`ValidationError`
  映射为 `400`。
- **鉴权**（需求 9.4）：用户维度资源（关注列表、告警）通过 `requireAuth` preHandler 强制鉴权，
  其背后是可注入的 `authenticate` 端口。安全默认：未配置鉴权器时，用户维度路由**默认关闭**
  （`401`），且每个操作都按已鉴权的 `userId` 限定，用户只能访问自己的数据。

## 告警 / 关注列表服务

`packages/alerts` 针对到来的价格/价差更新评估用户告警规则，并通过网关的 `alerts` WebSocket
频道派发通知。支持两类规则：`thresholdCross`（某市场概率穿越阈值）与 `spreadWiden`（某规范
事件的价差扩大到超过最小阈值）。关注列表与告警规则的持久化（关注项带去重）位于
`packages/storage`。

## 前端（`apps/web`）

一个 Next.js（App Router）+ React 18 应用。它**只**通过
`apps/web/src/lib/api-client.ts` 中唯一的类型化客户端（经 `NEXT_PUBLIC_API_BASE_URL`
配置）与本项目自己的 API 网关通信，绝不访问上游平台（需求 9.1）。它在本地镜像网关的 DTO
形状（`apps/web/src/lib/dto.ts`），因此唯一的耦合是 HTTP 契约。

页面：发现列表（筛选、全文搜索、排序）、含价格历史曲线的市场详情、并排对比视图（含不一致标记）、
仅供展示的信号列表（带「去交易」深链接按钮）、以及关注列表管理。一个 WebSocket 扇出客户端
（`apps/web/src/lib/fanout-client.ts` + `useFanout.ts`）订阅实时价格/价差/告警更新。

该应用刻意与后端的 `tsc --build` project-reference 图隔离（它需要 DOM/JSX/打包器解析）：单独
通过 `npm run typecheck`（`tsc --noEmit`）做类型检查，用 `next build` 构建。它的测试在根
`npm test` 下通过 `web` Vitest 项目（jsdom + Testing Library）运行。完整的 monorepo 集成决策
见 [README](../../README.md#frontend-appsweb)。

## 正确性属性（P1–P9）

设计文档的正确性属性以 `fast-check` 基于属性的测试编码，每条都映射到一个需求。它们随
`npm test` 一并运行。完整的「属性 → 测试文件 → 需求」映射及各自保证见
[`correctness-properties.md`](./correctness-properties.md)。

| #   | 属性                       | 位置                                                                    |
| --- | -------------------------- | ----------------------------------------------------------------------- |
| P1  | 幂等摄取                   | `storage/.../idempotent-ingestion.property.test.ts`                     |
| P2  | 幂等价格写入               | `storage/.../idempotent-price-writes.property.test.ts`                  |
| P3  | 概率边界                   | `core/src/model/normalization.property.test.ts`                         |
| P4  | 不产生伪套利               | `matching/src/no-false-arbitrage.property.test.ts`                      |
| P5  | 仅供展示不变量             | `matching/src/display-only.property.test.ts`                            |
| P6  | 游标单调性                 | `ingestion/src/cursor-monotonicity.property.test.ts`                    |
| P7  | 能力门控                   | `ingestion/src/capability-gating.property.test.ts`                      |
| P8  | 适配器隔离                 | 结构性 —— 每个适配器一个目录；由布局 + P7 门控印证                       |
| P9  | 对比对称性                 | `matching/src/comparison-symmetry.property.test.ts`                     |

## 本地开发

```bash
# 1. 安装 workspace 依赖
npm install

# 2. 启动数据存储（Postgres + TimescaleDB、Redis）
docker compose up -d

# 3. 构建、检查、测试
npm run build
npm run lint
npm test
```

连接串见 [`.env.example`](../../.env.example)，与 `docker-compose.yml` 默认值一致。迁移通过
`npm run migrate --workspace @pma/storage` 应用（见
[`packages/storage/migrations/README.md`](../../packages/storage/migrations/README.md)）。

## 文档导航

- [`architecture.md`](./architecture.md) — 本文档：系统导览、分层、数据流、匹配各层、API 接口、
  加固、正确性属性。
- [`data-model.md`](./data-model.md) — 规范化数据结构：实体、存储表、幂等键、索引、校验规则。
- [`adapter-authoring-guide.md`](./adapter-authoring-guide.md) — 如何通过实现 `MarketSource`
  接口接入新平台。
- [`correctness-properties.md`](./correctness-properties.md) — P1–P9 基于属性的保证及其测试文件
  与需求的映射。
- [`compliance-and-future-seams.md`](./compliance-and-future-seams.md) — v1 只读姿态与预留的
  未来阶段合规接缝。
- [权威详细设计（英文）](../../.kiro/specs/prediction-market-aggregator/design.md)。

## 只读保证（v1）

价差/套利输出仅供参考。每个信号都带 `executable: false`，v1 中不存在任何执行或下单路径。
未来预留接缝见设计文档的「Compliance Considerations」，以及
[`compliance-and-future-seams.md`](./compliance-and-future-seams.md)：说明 v1 的只读姿态与预留
的合规接缝（按来源的再分发策略、用户区域维度、可替换的 trade-link 插槽）如何在不实现任何受监管
逻辑的前提下被记录下来。

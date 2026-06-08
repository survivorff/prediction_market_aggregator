# 预测市场聚合器（Prediction Market Aggregator）

> English version: [`README.md`](./README.md)

一个独立的、**只读**的对比看板与数据服务，把多个平台（v1：Polymarket 与
Manifold）的预测市场统一到同一套规范化数据模型中。它让用户可以：

- 在一个界面里搜索、浏览跨平台的市场；
- 跨平台并排比较同一个真实世界问题的隐含概率；
- 把跨平台最大价差作为**仅供展示**的信号呈现出来。

> v1 严格只读：**不下单、不路由资金、不执行交易。** 对外的「去交易（Go trade）」
> 只是一个跳转到来源平台的深链接（deep-link），它为未来的「一键参与
> （one-click participate）」流程预留了插槽，无需重写即可接入。

## 仓库结构

这是一个使用 **npm workspaces** 的 TypeScript monorepo。

```text
packages/
  core/        # 规范化领域模型、类型、端口（无 I/O）
  adapters/    # 每个平台一个 MarketSource 实现（polymarket、manifold、predictfun）
  ingestion/   # 编排器、调度器、轮询器、WebSocket 管理、幂等写入
  matching/    # 同一问题匹配引擎（规则 → 语义 → 校准 → 结算口径对齐）
  storage/     # Postgres/TimescaleDB 仓储、Redis 缓存、数据库迁移
  api/         # REST + WebSocket 扇出的对外网关
  alerts/      # 关注列表 + 价格异动告警引擎
apps/
  web/         # Next.js 前端
docs/          # 架构、数据模型、适配器开发指南等文档
```

完整中文文档见 [`docs/zh/`](./docs/zh/README.md)；英文文档见
[`docs/architecture.md`](./docs/architecture.md)。

## 快速开始

需要 Node.js >= 20 与 Docker（用于本地数据存储）。

```bash
# 安装 workspace 依赖
npm install

# 启动 Postgres + TimescaleDB 与 Redis
docker compose up -d

# 应用数据库迁移
npm run migrate --workspace @pma/storage

# 构建所有包
npm run build

# 代码检查与格式检查
npm run lint

# 运行测试套件（单元测试 + 基于属性的测试 + 集成测试）
npm test
```

集成测试会连接 `docker-compose` 启动的 TimescaleDB + Redis；连接不可用时这些用例会
优雅跳过（不会让套件失败）。

## 技术栈

- **语言：** TypeScript（跨 workspace 的 project references）
- **测试：** [Vitest](https://vitest.dev) + [fast-check](https://fast-check.dev)（基于属性的测试）
- **检查 / 格式化：** ESLint（flat config）+ Prettier
- **数据存储：** Postgres + TimescaleDB、Redis（见 `docker-compose.yml`）

## 前端（`apps/web`）

Web 应用是一个 [Next.js](https://nextjs.org)（App Router）+ React 18 +
[Recharts](https://recharts.org) 项目，渲染统一发现列表（筛选、全文搜索、排序）、
市场详情页（含价格历史曲线）、并排对比视图、仅供展示的价差信号列表，以及关注列表
管理。

它**只**通过 HTTP 与本项目自己的 API 网关（`@pma/api`）通信，绝不直接访问任何上游
平台（需求 9.1）。唯一的访问入口是
`apps/web/src/lib/api-client.ts` 中的类型化客户端，通过
`NEXT_PUBLIC_API_BASE_URL` 配置（默认 `http://localhost:4000`）。

## 许可证

MIT

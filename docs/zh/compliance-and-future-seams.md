# 合规与未来阶段预留接缝

> 状态：持续维护的活文档。权威设计见
> [`.kiro/specs/prediction-market-aggregator/design.md`](../../.kiro/specs/prediction-market-aggregator/design.md)
> 的「Compliance Considerations」与「Future Evolution」。英文版本：
> [`docs/compliance-and-future-seams.md`](../compliance-and-future-seams.md)。

本文档记录 **v1** 的合规姿态，以及架构为后续受监管阶段**预留**的接缝（seam）。指导原则：v1 在结构上只读，
而每一项未来受监管的能力都是一个*预留接缝*——已为之设计，但**未实现**且**不可达**。

## v1 严格只读（需求 12.1）

v1 **不**暴露任何交易、下单、资金路由或执行能力。具体地：

- 系统不持有任何交易凭证，也不打开任何托管/执行代码路径。最大一类风险（托管/执行）在结构上不存在。
- 价差 / 套利输出**仅供展示**：每个信号都带 `executable: false`，由 API 契约强制。
- 唯一的对外动作是一个跳转到来源平台的**导航**深链接（见
  [trade-link 接缝](#trade-link-替换接缝需求-63)）。

本文档中的任何内容都不改变上述事实。下面的接缝都是惰性占位：v1 代码不读取也不据此做门控。

## 按来源的再分发策略接缝（需求 12.2）

在商业/B2B 使用之前，必须遵守各平台关于数据再分发的服务条款，且可能需要按来源对暴露做门控。

**预留接缝：** `source.redistribution_policy` —— 一个 `JSONB` 列（迁移
[`002_compliance_seams.sql`](../../packages/storage/migrations/002_compliance_seams.sql)，默认
`'{}'::jsonb`）。它允许按来源**记录**一份策略，而不把 schema 绑定到任何特定形状或任何执行逻辑。未来可能的内容
示例（v1 不解读）：

```json
{ "b2b": "restricted", "attribution_required": true, "notes": "see ToS" }
```

**v1 行为：** 该列**仅记录**。没有代码读取它，也没有响应据此门控。后续的商业/B2B 阶段会加入门控层；该列已存在，
因此那次改动无需 schema 重写。

它可选地作为来源仓储记录上的只读字段暴露（`SourceRecord.redistributionPolicy`），供检视/管理工具使用 —— v1 中
仍然从不用它来门控任何响应。

## 用户区域维度接缝（需求 12.3）

某些未来受监管阶段需要对用户做**地理分区**（例如 Polymarket 有美国地区限制；后续阶段可能把美国用户路由到
符合 CFTC 的路径，把其他地区路由到 crypto 原生路径）。

**预留接缝：** 一个带可空 `region` 列的 `user_profile` 表（迁移
[`002_compliance_seams.sql`](../../packages/storage/migrations/002_compliance_seams.sql)）。独立表是侵入性最小的
预留：它不改动现有的用户维度表（`watchlist_item`、`alert_rule`），也不加外键（v1 没有 users 表 —— `user_id` 是
鉴权提供的不透明 UUID）。

**v1 行为：** `region` 列**预留且不被解读**。v1 不实现任何路由、地理围栏或基于区域的门控。该维度存在的唯一目的，
是让后续受监管阶段能够填充并据此分区，而无需 schema 重写。

## trade-link 替换接缝（需求 6.3）

「去交易」动作是未来**一键参与**的插槽。在 v1 中它是一个导航深链接；架构精确地预留了这个插槽，使后续的执行阶段
能够接入而**不改动发现、对比或信号的契约**。

**该接缝今天如何工作：**

- `GET /api/markets/{id}/trade-link` 返回 `{ url, executable: false }`。
- 处理器依赖一个注入的 `TradeLinkResolver` 端口（`GatewayDeps.tradeLink`）。默认基于注册表的解析器位于
  [`packages/api/src/trade-link.ts`](../../packages/api/src/trade-link.ts)，是**纯**的（无 I/O）：它把市场已存储的
  `(sourceKey, externalId, slug?)` 映射成一个公开的来源 URL，并**始终**设置 `executable: false`（需求 6.2、12.1）。
- 接入一个平台的深链接 = 在解析器注册表里加一条 builder。路由、处理器与 DTO 都不变。

**未来阶段如何替换它：**

- 未来的「一键参与」流程通过 `GatewayDeps.tradeLink` 换入一个**不同**的 `TradeLinkResolver` —— 例如返回一个由运营方
  自己的钱包/交易所支撑的可执行动作。
- 因为发现、对比与信号从不依赖 trade-link 解析器，那次替换只触及注入的解析器，其他契约不受影响（需求 6.3）。
- 那个执行阶段才是受监管业务的起点；它需要专门的合规/地理围栏设计（使用上文的
  [区域接缝](#用户区域维度接缝需求-123)），并明确**不在 v1 范围内**。接缝存在；逻辑不存在。

## 小结

| 接缝                         | 位置                                          | v1 状态                      | 为何预留                              |
| ---------------------------- | --------------------------------------------- | ---------------------------- | ------------------------------------- |
| 只读不变量                   | API 契约（`executable: false`）               | 强制执行                     | —（需求 12.1）                        |
| `redistribution_policy`      | `source` 列（JSONB）                          | 仅记录，从不门控             | B2B/商业门控（需求 12.2）             |
| 用户 `region`                | `user_profile.region`（可空）                 | 预留，不被解读               | 受监管的地理分区（需求 12.3）         |
| trade-link 解析器            | `GatewayDeps.tradeLink` 端口                  | 仅导航，不可执行             | 一键参与（需求 6.3）                  |

# 正确性属性（P1–P9）

> 状态：持续维护的活文档。权威定义见
> [`.kiro/specs/prediction-market-aggregator/design.md`](../../.kiro/specs/prediction-market-aggregator/design.md)
> 的「Correctness Properties」。英文版本：[`docs/correctness-properties.md`](../correctness-properties.md)。
> 本文档把每条属性映射到编码它的测试，让基于属性的保证可被发现。

设计文档陈述了九条应当对所有合法输入都成立的属性。其中八条以
[`fast-check`](https://fast-check.dev) 的**基于属性的测试（PBT）**编码；第九条（适配器隔离，P8）是一项
结构性保证，由架构 + 能力门控测试印证，而非独立的 PBT。每个属性测试都在源码里以
`**Validates: Requirements X.Y**` 注解回链到验收标准。

## 属性 → 测试映射

| #   | 属性                       | 校验      | 由谁编码                                                                                                                                                       | 类型       |
| --- | -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P1  | 幂等摄取                   | 需求 7.1  | [`packages/storage/src/repositories/idempotent-ingestion.property.test.ts`](../../packages/storage/src/repositories/idempotent-ingestion.property.test.ts)       | PBT        |
| P2  | 幂等价格写入               | 需求 7.2  | [`packages/storage/src/repositories/idempotent-price-writes.property.test.ts`](../../packages/storage/src/repositories/idempotent-price-writes.property.test.ts) | PBT        |
| P3  | 概率边界                   | 需求 1.3  | [`packages/core/src/model/normalization.property.test.ts`](../../packages/core/src/model/normalization.property.test.ts)                                         | PBT        |
| P4  | 不产生伪套利               | 需求 3.2  | [`packages/matching/src/no-false-arbitrage.property.test.ts`](../../packages/matching/src/no-false-arbitrage.property.test.ts)                                   | PBT        |
| P5  | 仅供展示不变量             | 需求 3.3  | [`packages/matching/src/display-only.property.test.ts`](../../packages/matching/src/display-only.property.test.ts)                                               | PBT        |
| P6  | 游标单调性                 | 需求 7.3  | [`packages/ingestion/src/cursor-monotonicity.property.test.ts`](../../packages/ingestion/src/cursor-monotonicity.property.test.ts)                               | PBT        |
| P7  | 能力门控                   | 需求 7.4  | [`packages/ingestion/src/capability-gating.property.test.ts`](../../packages/ingestion/src/capability-gating.property.test.ts)                                   | PBT        |
| P8  | 适配器隔离                 | 需求 8.1  | 结构性（模块边界）+ 由 P7 能力门控测试强化                                                                                                                     | 结构性     |
| P9  | 对比对称性                 | 需求 2.2  | [`packages/matching/src/comparison-symmetry.property.test.ts`](../../packages/matching/src/comparison-symmetry.property.test.ts)                                 | PBT        |

这八个 PBT 文件对应 spec 任务 2.3（P3）、3.4（P1）、3.5（P2）、4.5（P7）、5.5（P6）、6.6（P4）、6.7（P5）、
6.8（P9）。

## 每条属性保证什么

- **P1 —— 幂等摄取。** 对同一上游状态重复同步后，行数与内容保持不变：
  `upsert(m) ∘ upsert(m) ≡ upsert(m)`。以 `(source_id, external_id)` 为键。
- **P2 —— 幂等价格写入。** 多次写入同一价格点（例如重连回填与实时 tick 重叠），在
  `(market_id, outcome_id, ts)` 下恰好得到一行，即使存在重复与乱序。
- **P3 —— 概率边界。** 对所有结果项，`0 ≤ impliedProb ≤ 1` 且 `0 ≤ lastPrice ≤ 1`；二元市场结果概率在容差 `ε`
  内求和为 1。
- **P4 —— 不产生伪套利。** 参与某价差信号的每个市场都满足 `resolutionMismatch = false`；结算口径不一致的配对
  绝不出现在 `/api/signals` 中，且对齐市场不足两个时不产生信号。
- **P5 —— 仅供展示不变量。** 返回的每个信号都带 `executable === false`。该字段被类型化为字面量 `false`，因此
  连 `true` 都无法构造（v1 没有执行路径）。
- **P6 —— 游标单调性。** 对给定来源，已持久化的游标在成功同步之间绝不回退，且只有在某页被持久化写入后才保存
  （崩溃安全续传）。
- **P7 —— 能力门控。** 只有当 `capabilities().websocketPrices === true` 时才调用 `subscribePrices`；否则该市场
  走轮询，且价格历史不缺失。
- **P8 —— 适配器隔离。** 增删一个适配器只改动该适配器自己的模块；规范化模型、匹配引擎与 API 契约不受影响。这
  由依赖规则（`adapters/*` 与 `api/` 依赖 `core/`；`core/` 不依赖任何东西）与「每个平台一个目录」的布局强制，
  并由能力门控测试（P7）在运行时印证。
- **P9 —— 对比对称性。** 规范事件成员关系是对称的（若 A 链接到 B，则 B 链接到 A），且 `maxSpread` 与行顺序无关，
  计算结果一致。

## 只运行属性测试

```bash
# 跨 workspace 运行所有属性测试：
npx vitest run -t "Property"

# 或按文件运行，例如「不产生伪套利」属性：
npx vitest run packages/matching/src/no-false-arbitrage.property.test.ts
```

完整套件（`npm test`）会把这些与单元测试、集成测试一起运行。

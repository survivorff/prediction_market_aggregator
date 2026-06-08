# 适配器开发指南

> 状态：完整。本指南带领开源贡献者通过在 `packages/adapters/src/<platform>/` 下新增**一个**目录、
> 实现 `MarketSource` 接口来接入一个新的预测市场平台，且对 `core`、`matching`、`api` **零改动**
> （需求 8.1、8.2）。权威接口位于
> [`packages/core/src/ports/market-source.ts`](../../packages/core/src/ports/market-source.ts)；
> 两个参考适配器是
> [`polymarket/`](../../packages/adapters/src/polymarket) 与
> [`manifold/`](../../packages/adapters/src/manifold)。英文版本：
> [`docs/adapter-authoring-guide.md`](../adapter-authoring-guide.md)。

## 目标：适配器隔离

接入一个平台是**局部改动**。你新建一个目录、实现一个接口、声明你的能力、注册适配器。系统其余部分
不导入你的代码，也不知道它的存在：

- 规范化模型（`@pma/core`）、
- 匹配引擎（`@pma/matching`）、
- 以及 API 契约（`@pma/api`）

都不受影响（需求 8.1 —— *适配器隔离*；设计属性 P8）。依赖规则由布局强制：`adapters/*` 只依赖
`@pma/core` 端口，而 `core/` 不依赖任何东西。

## 契约：`MarketSource`

你的适配器实现 `@pma/core` 的 `MarketSource` 端口。这是**真实落地**的接口（节选 —— 完整 JSDoc 见源码）：

```typescript
// packages/core/src/ports/market-source.ts
interface MarketSource {
  readonly meta: SourceMeta;

  // 元数据同步（keyset 分页，通过 `updatedSince` 增量）。
  fetchEvents(opts: PageRequest): Promise<Page<NormalizedEvent>>;
  fetchMarkets(opts: PageRequest): Promise<Page<NormalizedMarket>>;

  // 价格 —— 拉取。
  fetchPriceSnapshot(marketIds: string[]): Promise<NormalizedPriceSnapshot[]>;
  fetchPriceHistory(marketId: string, range: TimeRange): Promise<NormalizedPricePoint[]>;

  // 价格 —— 推送（仅当 capabilities().websocketPrices === true 时存在）。
  subscribePrices?(marketIds: string[], handler: PriceTickHandler): Subscription;

  capabilities(): SourceCapabilities;
}
```

### `meta: SourceMeta`

你的来源的标识。用一个稳定的 `key` slug 来书写；注册时由注册表填充解析后的内部 `id`（见
[注册你的适配器](#5-注册它)）。

```typescript
interface SourceMeta {
  id: string; // 内部 UUID —— 由注册表解析；这里用占位值
  key: string; // 稳定 slug："polymarket" | "manifold" | "<你的平台>"
  name: string; // "Polymarket"
  type: SourceType; // "onchain" | "cex" | "regulated"
  baseCurrency: string; // "USDC"、"MANA"……
}
```

两个参考适配器都设置占位 id，让注册表解析真实值：

```typescript
// packages/adapters/src/polymarket/index.ts
const PLACEHOLDER_SOURCE_ID = "00000000-0000-0000-0000-000000000000";
this.meta = {
  id: options.sourceId ?? PLACEHOLDER_SOURCE_ID,
  key: POLYMARKET_KEY, // "polymarket"
  name: "Polymarket",
  type: "onchain",
  baseCurrency: "USDC",
};
```

> 选择 `type`：联合类型是 `"onchain" | "cex" | "regulated"`。当没有完美匹配时，选择最接近的并说明原因。
> Manifold 是一个游戏币（MANA）平台；其适配器用 `"onchain"` 配 `baseCurrency: "MANA"`，并在文件头注释里
> 解释了这个选择。

### `capabilities()` 与能力门控

你的适配器**声明它支持什么**，编排器只会调用你的能力所允许的可选方法（需求 8.3；设计属性 P7）。
请如实声明：

```typescript
interface SourceCapabilities {
  websocketPrices: boolean; // true → 实现了 subscribePrices；编排器会流式订阅活跃市场
  priceHistory: boolean; // true → fetchPriceHistory 返回真实历史（曲线 + 重连回填）
  orderBookDepth: boolean; // true → 提供订单簿深度（如 Polymarket CLOB）
  keysetPagination: boolean; // true → 基于游标的 keyset 分页；false → 退化为 offset
}
```

两个参考适配器展示了能力谱系的两端：

| 能力               | Polymarket | Manifold | Predict.fun | 当为 `false` 时的效果                                          |
| ------------------ | ---------- | -------- | ----------- | ------------------------------------------------------------- |
| `websocketPrices`  | `true`     | `false`  | `false`     | 编排器从不调用 `subscribePrices`；该来源走轮询。              |
| `priceHistory`     | `true`     | `true`   | `true`      | 重连回填 / 曲线只能退化为快照。                              |
| `orderBookDepth`   | `true`     | `false`  | `true`      | 市场详情省略深度。                                          |
| `keysetPagination` | `true`     | `true`   | `true`      | 使用 offset 分页退化方案。                                  |

由于 Manifold 声明 `websocketPrices: false`，其适配器**根本不定义** `subscribePrices` 方法 —— 编排器也
绝不会调用它。这就是能力门控保证（由
[`capability-gating.property.test.ts`](../../packages/ingestion/src/capability-gating.property.test.ts)
验证）。

## 每个目录的文件布局

两个参考适配器都使用同样的自包含结构。请照此组织，让每个平台保持隔离且可测试：

```text
packages/adapters/src/<platform>/
├── index.ts        # MarketSource 实现（只做 I/O 编排）
├── http.ts         # 可注入的 HTTP 传输（基于 fetch 的 HttpClient）
├── socket.ts       # 可注入的 WebSocket 传输（仅当你推送价格时）
├── cursor.ts       # 不透明 keyset 游标的编码/解码/前进
├── mapper.ts       # 纯函数：原始载荷 → 规范化实体的映射
├── safe.ts         # 纯函数：针对不可信载荷的安全访问器
├── __fixtures__/   # 用于测试的录制上游载荷
└── *.test.ts       # mapper/cursor/index/fixtures 测试
```

这种分离很重要：`index.ts` 做 I/O，并把所有形状转换委托给**纯**的 `mapper.ts`，后者使用**纯**的
`safe.ts` 访问器。这让字段映射逻辑无需任何网络访问即可单元测试。

## 分步指南

### 1. 创建目录

`packages/adapters/src/<platform>/`。新增一个 `index.ts`，导出一个 `implements MarketSource` 的类，再加一个
稳定的 `KEY` 常量。

### 2. 注入你的传输（可测试性）

绝不直接闭包捕获全局 `fetch`。依赖一个窄接口 `HttpClient`：生产环境默认用 `fetch`，测试中替换为 fake。
这正是两个适配器 `http.ts` 中的写法：

```typescript
export interface HttpClient {
  get(url: string, options?: HttpGetOptions): Promise<HttpResponse>;
}
export function createFetchHttpClient(fetchImpl?: FetchLike): HttpClient {
  /* … */
}
```

```typescript
// 你的适配器构造函数 —— 一切可选，生产默认已接好：
constructor(options: MyAdapterOptions = {}) {
  this.http = options.http ?? createFetchHttpClient(options.fetchImpl);
  this.now  = options.now  ?? (() => new Date());   // 可注入的时钟，保证 ts 确定性
}
```

若你要推送价格，也注入一个 `WebSocketFactory`（见 Polymarket 的
[`socket.ts`](../../packages/adapters/src/polymarket/socket.ts)，它提供了用于测试的 `FakeWebSocket`）。
只需要 GET —— **v1 严格只读**（需求 12.1）；适配器不做任何写操作。

### 3. 用 keyset 分页实现元数据同步

`fetchEvents` / `fetchMarkets` 接收一个 `PageRequest`（`{ cursor?, limit, updatedSince? }`）并返回一个
`Page<T>`（`{ items, nextCursor }`）。把 `cursor`/`nextCursor` 当作**不透明**字符串；在 `cursor.ts` 里封装
平台的分页方案。

Manifold 的游标模块是个简洁的例子：它把 `{ before: <contractId> }` 做 base64url 编码，解码时绝不抛错
（畸形 → 回到起点），并在流末尾把 `nextCursor` 算为 `null`：

```typescript
// packages/adapters/src/manifold/cursor.ts（节选）
export function computeNextCursor(input: {
  lastId: string | null;
  pageSize: number;
  limit: number;
}) {
  if (input.pageSize < input.limit) return null; // 短页 → 流末尾
  if (input.lastId === null) return null; // 无法安全前进 → 末尾
  return encodeCursor({ before: input.lastId });
}
```

若你的平台没有一等的「event」资源，则从 `fetchEvents` 返回一个空的终止页（像 Manifold 那样），并从市场
自身派生分组。

### 4. 规范化不可信载荷（最重要的模式）

每个上游响应都是**形状未知的不可信 JSON**。绝不直接索引原始对象。一切都经过纯的 `safe.ts` 访问器，让缺失
或畸形字段变成显式的 `null`/`[]`，而非抛出错误（需求 1.5）。参考 `safe.ts` 提供：

- `isRecord`、`getField`、`getFirstField` —— 有保护的属性访问，
- `asStringOrNull`、`asFiniteNumberOrNull`、`asBoolean`、`asArray` —— 强制类型转换，
- `parseStringifiedArray` —— 用于把数组 JSON 编码成字符串的平台，
- `toIsoTimestampOrNull` —— ISO / epoch 秒 / epoch 毫秒 → ISO。

然后在纯的 `mapper.ts` 中映射，遵守模型规则：

- **概率 → `[0, 1]`**，用 `normalizeProbability`；并用 `normalizeBinaryProbabilities`（`@pma/core`）把二元
  结果校正到求和约等于 1。
- **价差 `>= 0`**，用 `normalizeSpread`。
- **始终保留 `resolutionCriteria.raw`**，即使结构化字段无法解析（需求 10.3）—— 用
  `normalizeResolutionCriteria`，它把 `raw` 默认为 `{}`，因此永不丢失。匹配第 4 层依赖它来标记结算口径
  不一致，避免伪套利信号。
- **`externalId` 是平台原生 id** —— 它构成 `(source_id, external_id)` 幂等键。
- **把你的类别标签映射**到规范化 `Category` 分类（`politics | crypto | sports | economics | tech | other`）；
  未知 → `other`。

实例 —— Polymarket 如何推导隐含概率：一个二元 Yes/No 市场是两个 Polygon 结果代币，**Yes 代币价格即隐含概率**。
Manifold 则直接读取二元合约的 `probability` 字段。两者最终都成为带 `impliedProb ∈ [0, 1]` 的规范化
`Outcome`。

### 5. 实现价格

- `fetchPriceSnapshot(marketIds)` —— 最新价（拉取）。跳过读不出的条目，而不是让整批失败（需求 1.5）。
- `fetchPriceHistory(marketId, range)` —— 用于曲线与重连回填的时间序列。Polymarket 读 CLOB `/prices-history`；
  Manifold 把 `/v0/bets`（`probAfter` + `createdTime`）映射成升序的 Yes 价格序列。
- `subscribePrices(marketIds, handler)` —— **仅当** `websocketPrices: true`。返回一个 `Subscription`
  （`close()` + `isOpen`）；编排器在其上驱动带退避的重连与回填。在纯 mapper 中规范化入站帧，**绝不**因
  畸形帧或异常的 handler 而抛错。

### 6. 注册它

接入一个平台在启动时只是一行；**其他调用点都不改**（需求 8.4）。注册表从你的稳定 `key` 解析 `meta.id`：

```typescript
// packages/ingestion/src/registry.ts
import { InMemoryAdapterRegistry } from "@pma/ingestion";

const registry = new InMemoryAdapterRegistry(resolveSourceId);
registry.register(new PolymarketAdapter());
registry.register(new ManifoldAdapter());
registry.register(new MyPlatformAdapter()); // ← 整个接入工作
```

然后从包桶文件
[`packages/adapters/src/index.ts`](../../packages/adapters/src/index.ts) 中与现有两个一起导出你的适配器。

### 7. 添加 fixture 测试

把真实上游载荷录制到 `__fixtures__/` 下，并断言你的 mapper 产出正确的规范化实体且游标能往返。两个参考
适配器都有 `mapper.test.ts`、`cursor.test.ts`、`fixtures.test.ts` 与 `index.test.ts`（完全由注入的 fake
传输驱动 —— 无网络）。至少覆盖：

- 一个典型市场 → 规范化 `Market` + `Outcome[]`，且 `impliedProb ∈ [0,1]`，
- 缺失/可选字段 → 显式 `null`（绝不抛错），
- 当结构化字段缺失时仍保留 `resolutionCriteria.raw`，
- 游标编码 → 解码 → 前进的往返，含流末尾 `null`。

## 规范化规则清单

- [ ] `impliedProb` 与二元 `lastPrice` 在 `[0, 1]` 内。
- [ ] 二元结果概率在容差（`0.01`）内求和约等于 1。
- [ ] `spread >= 0`（或 `null`）。
- [ ] `resolutionCriteria.raw` 始终保留。
- [ ] 缺失值显式表示（`null`），绝不抛错。
- [ ] `externalId` 是平台原生 id；`(source_id, external_id)` 是幂等键。
- [ ] `capabilities()` 如实声明；当且仅当声明了，可选方法才存在。

## 参考适配器

- **Polymarket**（[`adapters/src/polymarket/`](../../packages/adapters/src/polymarket)）—— Gamma API
  （元数据，keyset 分页）+ CLOB API（快照/历史/深度）+ WebSocket market 频道。声明**所有**能力为 `true`。
  这是完整版示例：拉取 + 推送价格、订单簿深度、注入的 HTTP **和** WebSocket 传输。
- **Manifold**（[`adapters/src/manifold/`](../../packages/adapters/src/manifold)）—— 仅 REST；
  `websocketPrices = false`，因此编排器把它走分层轮询（适配器**不定义** `subscribePrices`）。这是最小版示例，
  推荐先读：它证明了无需依赖 WebSocket 也能完成规范化 + 同一问题匹配。
- **Predict.fun**（[`adapters/src/predictfun/`](../../packages/adapters/src/predictfun)）—— 集成进
  Binance 钱包的 BNB 链 CLOB 平台。仅 REST（`websocketPrices = false`），但 `orderBookDepth = true`：
  市场列表不带价格，适配器从 `/orderbook` 的最优买/卖价**中值**推导 Yes 隐含概率。这是「有订单簿但无价格
  WebSocket」来源的范例，也演示了可选的 mainnet `x-api-key` 请求头。

另见 [`packages/adapters/README.md`](../../packages/adapters/README.md)（精简版），以及
[`data-model.md`](./data-model.md)（你要映射进去的实体）。

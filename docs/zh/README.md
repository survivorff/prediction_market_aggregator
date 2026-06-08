# 中文文档（Chinese Documentation）

> English documentation lives in [`docs/`](../). 本目录是与英文文档对应的中文翻译版本。

预测市场聚合器（Prediction Market Aggregator）是一个独立的、**只读**的跨平台预测
市场对比看板与数据服务。本套中文文档面向贡献者与使用者，提供与英文文档一致的内容。

## 文档导航

- [系统设计总览（技术 + 业务）](./system-design.md) — **一站式**全景文档：把业务背景、系统上下文、
  分层架构、数据流、匹配引擎、数据模型、API 网关、告警、前端、正确性属性、合规接缝与部署整合在
  一处，全部架构流程图用 mermaid 绘制。
- [架构总览](./architecture.md) — 系统定位、分层、数据流、匹配引擎各层、API 接口、
  网关加固、正确性属性。
- [数据模型](./data-model.md) — 规范化数据结构：实体、存储表、幂等键、索引、校验规则、
  Redis 热缓存与发布/订阅频道。
- [适配器开发指南](./adapter-authoring-guide.md) — 如何通过实现 `MarketSource` 接口
  接入一个新平台（只改一个目录）。
- [正确性属性 P1–P9](./correctness-properties.md) — 基于属性的测试（PBT）保证与其测试
  文件、需求条目的对应关系。
- [合规与未来阶段预留](./compliance-and-future-seams.md) — v1 的只读姿态与为后续受监管
  阶段预留的接缝（seam）。

## 项目根文档

- [中文 README](../../README.zh-CN.md) — 项目简介、仓库结构、快速开始。
- [English README](../../README.md)
- [权威设计文档（英文）](../../.kiro/specs/prediction-market-aggregator/design.md)

## 关于本翻译

- 中文文档与英文文档逐篇对应，内容保持一致；当两者出现分歧时，**以英文文档与代码为准**。
- 代码标识符、文件路径、API 路径、SQL 字段名等保留英文原文，以便与代码对照。
- 「需求 X.Y」对应 `requirements.md` 中的验收标准编号；「P1–P9」对应设计文档中的正确性
  属性编号。

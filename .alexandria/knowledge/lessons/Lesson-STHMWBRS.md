---
lesson: triage-must-not-rely-on-nonreproducible-model-output
module: src/triage
tags: [triage, reproducibility, llm-output, guardrail]
source: zhiya
guard-strength: directive
applies-when:
  - 实现或修改分诊、路由、优先级判定逻辑
  - 将模型输出写入工单状态、告警级别或自动处理决策
---

# 分诊结果不能依赖不可复现的模型输出

## Symptom

同一输入在不同时间、不同模型版本或不同采样参数下得到不同分诊结论；线上无法解释某条工单为什么被分到某个队列，也无法在回归测试中稳定复现。

## Root Cause

把 LLM 的非确定性原始输出直接当作最终分诊决策，没有固定模型版本、prompt 模板、温度/随机种子和结构化校验，导致结果不可审计、不可回放、不可回归。

## Fix

分诊链路必须改成可复现决策：

1. 锁定模型 ID、prompt 模板哈希、temperature=0、top_p 与 seed；若平台不支持固定 seed，则必须记录该限制并降级为人工复核。
2. 将模型输出解析到受约束 schema，禁止把自由文本直接作为最终状态。
3. 对关键分诊字段做确定性后处理：规则校验、枚举白名单、置信度阈值、冲突检测。
4. 落库时必须保存可复现证据包：输入快照、prompt_hash、model_id、参数、原始输出、解析结果、决策版本。
5. 无法复现或低置信度的分诊必须标记为 `needs_review`，不得自动进入高影响动作。

## Guard

- 禁止把未记录 model_id、prompt_hash、temperature、seed 的模型输出写入最终 triage label。
- 任何分诊结果落库前必须通过 reproducible bundle 校验；缺失字段直接拒绝提交并转人工。
- 关键分诊用例必须加入固定快照回归测试，不允许只验证“能跑通”。
- 若更换模型或 prompt，必须重新生成回归基线，否则禁止上线。

## Evidence

- `src/triage/service.ts#runTriage`
- `prompts/triage.md`（prompt_hash）
- `tests/triage-repro.spec.ts`
- 命令：`pnpm test -- triage-repro.spec.ts`

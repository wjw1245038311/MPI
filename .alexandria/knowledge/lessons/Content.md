---
lesson: thinking-model-empty-content-topic-six-questions
module: src/main
tags: [reasoning-model, empty-content, classification, token-budget]
source: zhiya
guard-strength: directive
applies-when: ["调用思考型模型做“归并主题+六问”分类", "提高 max_tokens 后 content 仍为空", "/no_think 位置变化导致结果不可复现"]
---

# 思考型模型执行“归并主题+六问”时 content 为空且不可复现

## Symptom

让思考型模型执行“归并主题+六问”分类时，即使把 max_tokens 提高到 12000、调整提示长度或 /no_think 位置，仍会因思考消耗导致 content 为空且不可复现。

典型表现：

- API 返回成功，但 `choices[0].message.content` 为空字符串或只有空白字符。
- `finish_reason` 可能为 `length`，或 usage 中 completion tokens 接近上限。
- 同一提示多次请求结果不稳定：有时空内容，有时输出不完整 JSON，有时才正常返回。
- 把 `/no_think` 放在开头、结尾或中间，不能稳定消除该问题。

## Root Cause

思考型模型会先生成内部 reasoning tokens，再生成最终可见 content。复杂任务“归并主题+六问”同时要求：

1. 对多个主题做语义归并；
2. 对每个归并结果回答六个问题；
3. 保持结构化输出；
4. 避免解释和额外文本。

这会显著增加 reasoning token 消耗。很多 API 的 `max_tokens` / `max_completion_tokens` 限制的是总生成量，包含 thinking tokens 与最终 content。当思考过程占满预算时，模型没有剩余 token 输出最终答案，于是 content 为空。

不可复现来自两个因素：

- 推理路径本身具有随机性；
- `/no_think` 只是提示词控制，不等同于 API 层关闭 reasoning mode，也不保证为最终输出预留 token。

因此只提高 `max_tokens`、调整提示长度或移动 `/no_think`，不能稳定解决问题。

## Fix

必须把任务拆小，并把“思考预算”和“输出预算”分开处理。

1. 禁止一次性要求模型完成“归并主题 + 六问分类”。
2. 拆成两个独立请求：
   - 第一个请求只做主题归并，返回 JSON；
   - 第二个请求基于已归并主题做六问分类，每个问题限定为枚举值或布尔值。
3. 提示词中强制结构化输出：
   - “只输出 JSON”

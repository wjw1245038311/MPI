---
lesson: keep-zhiya-dream-llm-classify-disabled-by-default
module: src/main
tags: [zhiya, llm-classify, feature-flag, model-type]
source: zhiya
guard-strength: directive
applies-when:
  - 修改 zhiyaDreamLlmClassify 开关时
  - 切换 LLM 分类所用模型时
  - 启用或关闭 LLM 分类能力时
---

# 保留 zhiyaDreamLlmClassify 开关且默认 false

## Symptom

如果删除、重命名 `zhiyaDreamLlmClassify`，或将其默认值改为 `true`，会在当前思考型模型下误启用 LLM 分类，导致行为不符合预期。

## Root Cause

LLM 分类能力目前只应在换用非思考型模型时启用；当前默认路径仍依赖思考型模型，不能默认打开该分类开关。

## Fix

保留名为 `zhiyaDreamLlmClassify` 的开关，并将其默认值固定为 `false`。只有确认已切换为非思考型模型后，才允许将该开关设为 `true` 以启用 LLM 分类。

## Guard

- 不得删除或重命名 `zhiyaDreamLlmClassify`。
- 不得将 `zhiyaDreamLlmClassify` 的默认值改为 `true`。
- 当前模型为思考型时，必须保持 `zhiyaDreamLlmClassify=false`。
- 只有换用非思考型模型并完成验证后，才允许启用 LLM 分类。

## Evidence

- 配置开关：`zhiyaDreamLlmClassify`
- 约束条件：默认 `false`
- 启用条件：仅当使用非思考型模型时

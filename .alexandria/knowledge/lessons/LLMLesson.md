---
lesson: deterministic-theme-six-question-rules
module: src/main
tags: [theme, six-question, heuristic-answers, llm-boundary]
source: zhiya
guard-strength: directive
applies-when: [修改主题或六问判定逻辑时, 调整 LLM 与规则职责边界时, 重构 lesson 生成流程时]
---

# 将主题/六问判定收回确定性规则，LLM 只写 lesson 正文

## Symptom

当主题或六问判定交给 LLM 输出时，结果会出现不稳定、不可复现、难以单测覆盖的问题；同一输入可能得到不同标签，导致下游流程无法依赖结构化字段。

## Root Cause

主题和六问属于可枚举、可验证的分类判定，适合用确定性规则处理。让 LLM 同时负责“判断”和“写作”，会模糊职责边界：LLM 擅长生成自然语言正文，但不适合作为最终的结构化决策器。

## Fix

将主题/六问判定收回 `heuristicAnswers` 中的确定性规则实现。代码先根据输入计算出主题与六问结果，再把这些已判定的上下文传给 LLM；LLM prompt 只要求它写 lesson 正文，不再让它输出或决定主题、六问等结构化字段。

## Guard

以后凡涉及主题或六问判定，必须使用 `heuristicAnswers` 中的确定性规则函数作为最终来源。禁止在 LLM prompt、解析器或下游逻辑中新增“让模型直接给出 theme / six-question 标签并作为最终结果”的路径。LLM 只允许生成 lesson 正文文本；所有结构化字段必须由规则填充。

## Evidence

- `heuristicAnswers`：主题/六问判定入口
- lesson 生成 prompt：应只要求 LLM 写正文，不要求输出主题或六问标签

---
lesson: no-reasoning-content-fallback-for-lesson-body
module: src/main
tags: [reasoning-content, fallback, lesson, knowledge-base]
source: zhiya
guard-strength: directive
applies-when: ["从模型响应提取 lesson 正文", "content 为空时准备使用 reasoning_content 兜底", "写入知识库前校验正文来源"]
---

# 禁止用 reasoning_content 兜底 lesson 正文

## Symptom

使用 `reasoning_content` 兜底正文会把模型的思考过程当作 lesson 写入知识库，并且已经真实发生过一次。

## Root Cause

模型响应中可能同时包含正式输出字段和推理字段。当提取逻辑在正式正文为空时回退到 `reasoning_content`，会把内部思考、草稿、自我纠正或无关分析当成最终结论保存，导致知识库混入非交付内容。

## Fix

lesson 写入前只允许使用明确标记为最终输出的正文字段作为来源。若该字段为空或缺失，不得用 `reasoning_content`、`thinking`、`analysis` 等推理字段补齐；应放弃本次 lesson 生成，或返回明确的“缺少正文”状态。

## Guard

硬性指令：禁止将 `reasoning_content` 用作 lesson 正文兜底。只要检测到候选正文来自推理字段，立即丢弃该记忆，不得写入知识库。若正式正文为空，必须停止保存并记录失败原因，而不是继续生成 lesson。

## Evidence

- 用户反馈：使用 reasoning_content 兜底正文会把模型的思考过程当作 lesson 写入知识库，并且已经真实发生过一次。
- 风险字段：`reasoning_content`
- 受影响对象：lesson / knowledge-base 写入流程

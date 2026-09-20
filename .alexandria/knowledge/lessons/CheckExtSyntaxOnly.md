---
lesson: check-ext-syntax-only
module: scripts/check-ext
tags: [check-ext, regex, scoring, validation, testing]
source: zhiya
guard-strength: directive
applies-when: ["修改正则表达式后", "修改打分逻辑或阈值后", "使用 check:ext 验证扩展行为时", "声称修复匹配/评分问题前"]
---

# check:ext 只验语法，不验语义

## Symptom

运行 `check:ext` 通过，但真实输入下正则误匹配、漏匹配，或打分结果不符合预期。合法正则和合法代码可能产生错误业务行为。

## Root Cause

`check:ext` 的验证范围是扩展/配置语法合法性，不会执行完整语义断言；它无法判断一个语法正确的正则是否表达正确意图，也无法判断打分公式、权重、阈值或分支逻辑是否符合需求。

## Fix

对涉及正则和打分的改动，补充能暴露“合法但错误”行为的测试：覆盖真实样例、边界输入、反例输入、期望匹配/不匹配集合、期望分数区间或排序结果。必要时用真实数据回放验证。

## Guard

以后凡修改正则、打分逻辑、阈值、权重或 `check:ext` 相关路径，必须新增并运行语义级测试；仅 `check:ext` 通过不得作为完成依据。若无法自动化，必须在交付说明中列出已执行的人工/真实使用验证步骤和结果。

## Evidence

- `check:ext` 命令：只报告语法检查结果
- 正则定义与打分计算路径：合法表达式/代码可产生错误匹配或分数
- 用户记忆原文：“check:ext 只能验证语法，无法发现合法但错误的正则或打分逻辑，因此相关路径必须通过测试或真实使用验证。”

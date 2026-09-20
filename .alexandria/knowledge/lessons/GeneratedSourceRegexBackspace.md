---
lesson: generated-source-regex-backspace
module: scripts/generate-extension
tags: [python, regex, escaping, code-generation]
source: zhiya
guard-strength: directive
applies-when: ["用 Python 脚本生成包含正则的扩展源码时", "生成的扩展源码中正则边界符 \\b 失效或出现控制字符时"]
---

# Python 生成扩展源码时避免正则多层转义

## Symptom

用 Python 脚本生成扩展源码后，正则里的 `\b` 不工作；打开生成文件可能看到不可见退格符、`\u0008` 或控制字符，导致词边界匹配失效。

## Root Cause

Python 普通字符串会把 `\b` 解释为 ASCII 0x08（backspace）。当正则经过脚本变量、模板、序列化或多层转义后，原本要写入源码的 `\b` 被替换成退格符，最终生成文件里的正则不再是词边界。

## Fix

在 Python 中写正则字面量时使用 raw string：`r'\b'`。如果通过模板或 JSON 生成源码，确保最终产物里是反斜杠加 `b`（`\b`），不是控制字符。生成后检查文件内容，例如用 `grep -P '\x08' <generated-file>` 或 Python `repr()` 确认没有退格符。

## Guard

禁止把含 `\b`、`\d`、`\w`、`\s` 等正则序列的字符串以普通 Python 字符串形式写入生成器；必须使用 raw string，或在模板中保持原始反斜杠。若生成脚本需要拼接正则，先断言目标文本包含 `\\b`（源码中的两个字符）而不是 `\x08`；否则直接失败，不写文件。

## Evidence

- `python -c "print(repr('\b'))"` 输出 `\x08`
- `python -c "print(repr(r'\b'))"` 显示字符串包含反斜杠和 `b`
- 生成扩展源码中的正则字面量（如词边界 `\b`）

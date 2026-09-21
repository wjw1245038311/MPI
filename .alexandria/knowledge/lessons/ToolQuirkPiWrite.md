---
lesson: tool-quirk-pi-write
module: unknown
tags: [tool-quirk, from-mem0, origin:平板, user-said]
source: zhiya
guard-strength: directive
applies-when: []
---

# [tool-quirk] pi write 工具写出的

> ⚠️ 本节骨架由知芽自动生成：正文取自**记忆原文**（未设置记忆模型，未生成 lesson 正文）。
> `module` / `tags` / 各节内容需要人工整理；下面「原文」一节保留原始记录。

## Symptom

<!-- TODO：什么现象下会踩到？ -->

## Root Cause

<!-- TODO：为什么？ -->

## Fix

<!-- TODO：正确做法 -->

## Guard

<!-- TODO：以后怎么避免 -->

## Evidence

<!-- TODO：日志/命令/文件 -->

## 原文（待整理）

[tool-quirk] pi write 工具写出的 .ps1 为 LF-only + UTF-8 无 BOM；PS 5.1（中文 Windows）按 GBK(936) 解码，cp936 遇非法字节对两字节都吞——中文注释行尾全角括号 ）(EF BC 89) 吃掉下一行 LF，代码行并入注释静默丢弃（症状：行为与源码不符、变量未赋值不报错）。规则：PS5.1 agent 的 .ps1 必须纯 ASCII 或带 UTF-8 BOM；排查用 [Text.Encoding]::GetEncoding(936).GetString(bytes) 逐行 dump。PS7(.NET Core) stdout 重定向时 Console.OutputEncoding 默认 UTF-8，agent 捕获测不出 GBK 乱码差异，真实交互控制台才是 profile UTF-8 行的保护场景。

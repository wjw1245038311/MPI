---
lesson: tool-quirk-git-hub-release
module: unknown
tags: [tool-quirk, from-mem0, origin:平板, from-pi-hermes, user-said]
source: zhiya
guard-strength: directive
applies-when: []
---

# [tool-quirk] GitHub release…

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

[tool-quirk] GitHub release 直连下载可能超慢/中途损坏（llama.cpp 242MB 实际只下到 142MB，unzip 报目录尾记录异常）：下载后须校验 zip 完整性；GitHub 不可达或过慢时走 ghfast.top 代理（实测 142MB/181s、18MB CPU 版 18s）。llama.cpp 官方 CPU 版压缩包仅 18MB，embedding 场景 CPU 推理够用。

# DSH Desktop 0.9 → 0.13.1 对照笔记

> 记录日期：2026-11-03 · 来源：`github.com/dataelement/dsh-desktop` 的 GitHub Releases（中文正文）
> 本机安装版本：**0.12.1**（从 `Agent/DSH/DSH Desktop/resources/app.asar` 的 `package.json` 读出）
> 最新版本：**0.13.1**（2026-11-02）
> 用途：给 MPI 找可借鉴项。**只记「对 MPI 成立」的差异**，产品形态不同的部分（工作台 / Office / PPT / 公文模板 / Harness 插件代际）只留一句结论。

## 1. 版本时间线

| 版本 | 日期 | 主线 |
|---|---|---|
| v0.9.0 | 09-15 | release note 几乎为空（只有标题「版本更新」） |
| v0.9.1 | 09-20 | 恢复/安全模式下的**浮动维修 Agent**；loader 超时诊断；模型不可用文案 |
| v0.9.2 | 09-23 | 重做**插件恢复页 + Safe Mode 管理器**；恢复流程不再依赖 profile 链接 |
| v0.10.0 | 09-26 | 也基本没写用户内容：合入 Harness 0.1.7-rc.2 底座 |
| v0.11.0 | 10-03 | **大版本**：工作台市场/启用开关/卸载语义、Office+PPT 运行时（打 Python）、拖入本地路径变 `@路径`、插件启用状态统一 |
| v0.11.1 | 10-09 | 工作台默认启用、市场英文化、首启引导落安装级状态文件 |
| v0.12.0 | 10-16 | 工作台双布局、Office 模板工作流、**桌面原生通知 + 通知聚焦**、Safe Mode 继承模型配置 |
| v0.12.1 | 10-20 | Harness 0.2.1-rc.2、旧预设自动迁移、市场分页+星标排序、**模型地址坏了也进得了设置页** |
| v0.13.0 | 10-28 | **启动故障修复主线**：维修 Agent（计划/错误详情/回滚位置）、**独立应用回滚页**、渲染进程恢复次数上限、GPU 故障有界恢复、MCP 启动限时、启动页动画+遮罩 |
| v0.13.1 | 11-02 | 侧边栏原生 WebView（租约管理）、模型能力识别+自定义模型、更新弹窗 Markdown、文件预览保留行号、麦克风权限白名单、Harness 0.2.2 + Electron 44.7 |

## 2. 三条主线

1. **启动/运行时可修复性**（0.9.1 → 0.9.2 → 0.13.0）：
   Safe Mode → 维修 Agent（已知恢复操作与 Agent 现场诊断分开）→ 应用回滚页 → 崩溃恢复**有界化**（reload 次数上限、GPU 耗尽转软件渲染、恢复导航失败退回重启）。
2. **工作台即插件生态**（0.11.0 → 0.13.1）：
   市场（分页/星标排序/来源与版本）、启用状态**单一事实源**、Profile 代际与陈旧安装清理、本地归档安装、会话创建收敛到工作台。
3. **Office/PPT 创作链**（0.11.0 → 0.13.1）：
   打包 Python 运行时、模板导入/转换/字体合规、LibreOffice 引擎路径规范化、构建缓存。**与 MPI 无关。**

## 3. 对 MPI 的判定

### 已借鉴（2026-11-03 落地，见 backlog 36–39）

| dsh | MPI 落地 |
|---|---|
| 渲染进程/GPU 有界恢复（0.13.0） | `src/main/crash-guard.ts` + `index.ts`：10min 窗口内 reload×2 → 软件渲染 relaunch → 再崩 2 次交用户；GPU 崩 2 次下次禁硬件加速 |
| 6h 定时 + 跳过版本 + 后台/手动分离（0.12.0/0.13.0） | `app-updater.ts` `startAppUpdateAutoCheck` + `appUpdateSkipVersion` 配置项 + `notifyAppUpdate` |
| 更新弹窗 Markdown（0.13.1） | `AppUpdateStatus.notes` + About 卡片 `<details>` 复用 `Markdown` |
| 启动遮罩（0.13.0） | `src/main/splash.ts` 内联 HTML，`ready-to-show`/失败/20s 兜底销毁 |

### 仍可做（backlog 40–42）

- 模型能力自动识别 + 自定义模型（MPI 只有 contextWindow 探测）
- 文件预览保留行号
- MCP 市场借它的分页/排序/启用状态一致性（与 backlog 05 合并做）

### MPI 已有，不必抄

- **桌面通知 + 点击聚焦并打开会话**：`system-notifications.ts` 早就有。
- **拖入文件/路径引用**：`file-drag.ts` + 附件链路（D1 已完成）。
- **更新日志体系**：MPI changelog 带「验证方式」，比 dsh release note 规范。
- **首启引导 / 语言跟随**：已有对应设置项。

### 不该抄

- **工作台 / Profile 代际 / 插件恢复页 / Safe Mode**：Harness 多插件宿主才有的问题；MPI 是 pi 单 runtime + 扩展，硬搬会引入第二套插件生命周期。
- **Office / PPT / 公文模板 / 内置 Python**：定位无关，且会把安装包从 ~160MB 推到 280MB+。
- **侧边栏原生 WebView**：MPI 已有独立预览与 PWA；真要做得先定「租约 + 权限白名单」边界。
- **Harness 版本适配 / 飞书发布门禁**：只对它的流程成立。

### 思路可借、实现别借

dsh 0.9.1 的「**浮动维修 Agent**」：把「已知恢复操作」和「Agent 现场诊断」分成两条路，Agent 修完能回到正常导航。MPI 的 `restart-dev.sh --dry-run` 已是「已知操作」那一半，缺的是坏了之后的**只读现场诊断入口**——可做成设置里的「运行诊断」页（读 diag 日志 + 依赖版本 + 端口占用），不必照搬它的 UI。

## 4. 附：原始材料

- `tempfile/dsh-changelog-0.9-0.13.md`（0.9.0–0.13.1 中文正文）
- `tempfile/dsh-releases.json`（GitHub API 原始响应，55 条 release）

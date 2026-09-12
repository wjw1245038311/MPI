# 变更 → 章节映射 & 用户可见性判定

配合 [workflow.md](workflow.md) 第 3 步使用。脚本只会给**初步**建议，最终以本表 + 你的判断为准。

## 一、手册章节总表（当前 22 章）

| # | 中文 | English |
|---|---|---|
| 1 | 认识 MPI | Getting to Know MPI |
| 2 | 安装与首次启动 | Installation and First Launch |
| 3 | 界面总览 | Interface Overview |
| 4 | 配置模型 | Configuring Models |
| 5 | 项目与会话管理 | Projects and Sessions |
| 6 | 与智能体对话 | Chatting with the Agent |
| 7 | 语音系统 | Voice System |
| 8 | 权限模式 | Permission Modes |
| 9 | 上下文管理 | Context Management |
| 10 | 文件预览与 HTML 元素引用 | File Preview and HTML Element References |
| 11 | 定时任务 | Automations (Scheduled Tasks) |
| 12 | 待办任务 | Todo Tasks |
| 13 | 扩展功能：技能 / 扩展包 / MCP | Extensions: Skills / Packages / MCP |
| 14 | Pi TUI 终端模式 | Pi TUI Terminal Mode |
| 15 | 全局搜索（Ctrl+K） | Global Search (Ctrl+K) |
| 16 | 归档与回收站 | Archive and Trash |
| 17 | 设置参考 | Settings Reference |
| 18 | Android 手机远程控制 | Android Phone Remote Control |
| 19 | 消息接入（飞书 / 微信） | Messaging Channels (Feishu / WeChat) |
| 20 | 快捷键速查 | Keyboard Shortcuts |
| 21 | 数据与配置位置 | Data and Configuration Locations |
| 22 | 常见问题 | FAQ |

> 无独立章节、按主题并入最近章节的功能：「任务模式」→ 并入 **6（与智能体对话）**；「工具信任列表」→ **8**；「备份与恢复」→ **17.6**。

## 二、主题关键词 → 目标章节

脚本用左侧关键词给建议；命中多个时按内容就近归并。

| changelog 主题关键词 | 目标章节 |
|---|---|
| 任务模式 / 行为指令 / 模式切换 / 思考档位（模式预设） | 6 |
| 智能体对话 / 会话选择卡片 / 提问卡片 / 消息渲染 / 工具调用展示 | 6 |
| 权限 / 只读 / 严格 / 沙盒 / 完全 / 权限拦截 / 工具信任 | 8 |
| 模型 / 提供商 / API Key / thinkingLevelMap / 思考默认值 | 4 |
| 语音 / 语音输入 / 语音输出 / STT / TTS | 7 |
| 上下文 / 压缩 / 摘要 / token | 9 |
| 预览 / HTML 元素编辑 / 批注 / Markdown 目录 | 10 |
| 定时任务 / 调度 / cron | 11 |
| 待办 / todo / 收件箱 | 12 |
| 扩展 / 技能 / skill / MCP / 扩展包 | 13 |
| TUI / 终端模式 | 14 |
| 全局搜索 / Ctrl+K | 15 |
| 归档 / 回收站 / 删除恢复 | 16 |
| 设置 / 主题 / 外观 / 缩放 / 头像 / 用户画像 / 备份恢复 / 诊断 | 17 |
| 安装 / 首次启动 / 运行时 / 更新 | 2、17.8 |
| 项目 / 会话管理 / 新建会话 / 重命名 | 5 |
| 界面 / 标题栏 / 左侧栏 / 聊天区布局 | 3 |
| 数据位置 / 迁移 / 存储目录 | 21 |
| Android / 远程 / 手机 | 18 |
| 消息接入 / 飞书 / 微信 / 钉钉 | 19 |
| 快捷键 | 20 |
| 错误码 / 常见问题 | 22 |
| 开发工具 / 自动化测试 / dev 发布 / 测试注册表 | （dev-only，见下） |

## 三、用户可见性判定

### ✅ 用户可见 → 进手册

- 新增 / 改变用户能看到、能点的**界面元素**（按钮、菜单、面板、标签页）。
- 新增 / 改变**操作流程**或**默认值**（默认权限、默认模式、默认主题…）。
- 新增**设置项**、快捷键、通知方式。
- 用户可感知的**行为变化**（例如「删除立即生效改为先进回收站」）。
- 新增**面向用户的错误提示 / 排错入口**。
- 平台 / 安装 / 更新方式的变化。

### 🚫 内部 → 跳过（要在汇报里说明原因）

- **dev-only**：只在开发版可见的工具（开发工具菜单、自动化测试面板、dev 一键发布）。普通用户看不到，不进正文。
  - 例外：若用户明确要求，可在 §17 末尾加一个**标注「仅开发版可见」**的小节集中说明，不混入正常功能。
- **测试基建**：tests/registry、harness、e2e 脚本、测试面板逻辑。
- **文档自身**：docs/*、changelog、README、本 skill。
- **重构 / 性能 / 类型 / 内部字段**：用户行为不变。
- **纯内部 bugfix**：用户无感知。
- **CI / 构建 / 发布脚本**：不影响使用方式。
- **打包 / 依赖升级**：除非改变安装或兼容性。

判定拿不准时，问自己：*普通用户会不会在界面上遇到这个变化？* 不会 → 内部。

## 四、与本 skill 相关的固定条目

以下 changelog 条目**永远视为内部**，差分时可直接跳过：

- 「功能测试注册表 / 应用内测试面板 / 测试运行器」
- 「测试文档分立（E2E-TESTING / FEATURE-TESTING）」
- 「dev 一键发布 / GitHub Actions 发版」
- 「标题栏开发工具下拉」
- 「用户手册 skill / manual-sync 同步机制」（本功能自身）

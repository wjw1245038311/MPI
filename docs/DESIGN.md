# MPI 桌面端 UI 设计规范（DESIGN.md）

> 面向：改 `src/renderer/**` 的任何人和 agent。
> 事实来源：`src/renderer/src/styles.css`（11,994 行，2026-10-27 扫描）、`src/main/index.ts`（窗口尺寸）。
> 移动端另有 `docs/MOBILE-DESIGN.md` / `docs/MOBILE-NATIVE-DESIGN.md`，本文只管桌面渲染层。
>
> **三条硬规则**：① 颜色/圆角/阴影优先用变量，不写裸 hex；② 新增样式必须同时给暗色（`:root[data-theme="dark"]`）；③ 浮层不要塞进 `overflow: auto` 容器里。

## 1. 视觉主题与氛围

| 项 | 现状 |
|---|---|
| 产品形态 | 桌面 AI 客户端（Electron），长时间阅读 + 对话 + 工具输出 |
| 浅色（默认） | 白底 / 米白面板（`#ffffff` / `#faf9f4`）+ 低饱和绿强调（`#2e7d52`） |
| 深色 | 蓝黑底（`#111619`）+ 亮绿强调（`#7bd6a1`） |
| 密度 | 紧凑：正文 14px，控件多在 11–13px，行高 1.4–1.55 |
| 情绪 | 安静、低对比、信息优先；强调色只用于「选中 / 链接 / 发送 / 进度 / 成功」 |

设计取向是**工具而不是展示页**：不加大面积渐变、不做装饰性插画；层次靠边框、面板底色和阴影，不靠彩色块。

## 2. 色板与角色

### 2.1 基础 token（`styles.css` 的 `:root` / `:root[data-theme="dark"]`）

| 变量 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` | `#ffffff` | `#111619` | 页面底色 |
| `--rail` | 三段绿/米渐变 | 三段蓝黑渐变 | 侧栏/纵向导航底 |
| `--rail-solid` | `#f1f4ee` | `#1a2124` | 实色侧栏块 |
| `--rail-2` | `#f7f7f4` | `#171e21` | 次级侧栏面 |
| `--border` | `#e7e7e1` | `#303c43` | 常规分割线/描边 |
| `--border-strong` | `#d8d8d0` | `#53636c` | 强调描边（引用块、输入框焦点前） |
| `--text` | `#1d1e1b` | `#e8eef0` | 正文 |
| `--text-dim` | `#6c7066` | `#b6c2c8` | 次要文字/说明 |
| `--text-faint` | `#9aa096` | `#8b98a0` | 元信息/占位 |
| `--accent` | `#2e7d52` | `#7bd6a1` | 强调、链接、选中 |
| `--accent-soft` | `#e4f1e8` | `#214333` | 强调底/焦点环 |
| `--send` / `--send-hover` | `#2b2d28` / `#3a3d35` | `#75c995` / `#8cdda9` | 主按钮 |
| `--send-fg` | `#ffffff` | `#102015` | 主按钮文字 |
| `--surface` | `#ffffff` | `#1b2327` | 卡片/面板底 |
| `--surface-muted` | `#faf9f4` | `#202a2f` | 次级面板底 |
| `--control` / `--control-hover` | `#f3f3ee` / `#ecece7` | `#273239` / `#33434a` | 图标按钮/输入控件 |
| `--code-bg` | `#f5f5f1` | `#151c20` | 行内代码/代码块 |
| `--user-bubble` | `#ffffff` | `#263830` | 用户气泡 |
| `--preview-*` | 独立一套 | 独立一套 | 文件预览区（允许与主界面不同，自成体系） |

### 2.2 强调色预设

`<html data-accent>` 覆盖 `--accent` / `--accent-soft` / `--send*`，共 7 组：
`default`（无属性）、`green`、`red`、`blue`、`white`、`lightgray`、`darkgray`。
**每组都必须有浅色与深色两版**（`:root[data-accent="x"]` + `:root[data-theme="dark"][data-accent="x"]`）。

### 2.3 语义色（尚未完全 token 化）

| 语义 | 取值 | 现状 |
|---|---|---|
| 错误 / 危险 | `#c0392b`（18 次）、`#b23a2c`（17 次） | 散落在搜索无结果、工具错误、录音状态、danger 按钮、陈旧横幅里，**建议收敛为 `--danger` / `--danger-soft`** |
| 上下文告警 | `--ctx-warn` `#ca8a04` / 深色 `#eab308`；`--ctx-mid` `#d97706` / `#fb923c`；`--ctx-hi` `#c0392b` / `#f2726a` | 已是变量（浅/深各一套，不是同值） |
| 成功/在线 | 多用 `--accent` | 无需新增 |

**规则**：要新颜色 → 先在 `:root` 和深色块各加一个变量，再在组件里引用。禁止在组件里直接写 `#xxxxxx`；半透明色同理会漏掉深色适配（见附录 A）。

## 3. 排版

| 项 | 现状 |
|---|---|
| 正文字体 | `--font`：`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif` |
| 等宽 | `--mono`：`ui-monospace, "Cascadia Code", "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", monospace` |
| 基准 | `body` 14px / 1.55；markdown 正文 14.5px / 1.65 |
| 现有字号 | 12px×110、12.5px×88、11px×76、13px×69、11.5px×59、10.5px×50、10px×18、15px×12、13.5px×11、16px×9、14px×8，另有 9.5/9/17/20/22/25px 少量 |
| 字重 | 400 / 500 / 600 / 650 / 700（650 用于「当前选中」类强调） |

**建议阶梯**（新代码按此选，不必回头改存量）：`10 / 11 / 12 / 13 / 14 / 16 / 22`。
元信息（时间、计数、路径）用 11–12px + `--text-faint`；不要把正文压到 12px 以下。
计数、耗时、路径、代码用 `--mono`。

## 4. 组件样式

| 组件 | 关键值 | 状态 |
|---|---|---|
| 顶栏 | 高 `--titlebar-h` 42px，底 `linear-gradient(180deg,#fbfbf9,#f4f4f0)`，下边框 `--border` | 拖拽区 `-webkit-app-region: drag` |
| 图标按钮 | 高由内边距决定（常用 4–6px），圆角 7–8px，底 `--control` | hover `--control-hover`；focus-visible 用 `--accent-soft` 环；disabled 降透明度 |
| 主发送按钮 | 底 `--send`，文字 `--send-fg`，圆角 8–10px | hover `--send-hover`；禁用 `opacity` |
| 卡片/面板 | 底 `--surface`，1px `--border`，圆角 12px，`--shadow-md` | 弹出层再加 `backdrop-filter: blur(8–10px)` |
| 用户气泡 | 底 `--user-bubble`，圆角 `12px 4px 12px 12px`（右上角切开），padding 9px 13px，`max-width: min(76%, 640px)` | 附件卡片同一圆角体系 |
| choices 面板 | 容器圆角 10px + 左侧 3px `accent` 边；选项行圆角 7px / 12.5px，选中 `--accent-soft` + 650 字重 | 冻结态显示 ✓；发送中禁用 |
| 左侧消息导航 | 圆点 6px（hover 9px、active 8px），条宽 18px，面板宽 300px，面板行 12.5px 单行 | 面板行悬停弹完整文本 tooltip（宽 440px，可滚动） |

**深色覆盖是单独一份**：同一选择器要写 `:root[data-theme="dark"] .xxx`。现有代码里导航点、面板、输入控件都是这么处理的——新增组件时漏掉这一条，深色下就是亮色块。

## 5. 布局原则

| 项 | 值 |
|---|---|
| 三栏 | 侧栏 `--sidebar-w` 286px / 主区自适应 / 预览 `--preview-w` 420px（可拖拽） |
| 窗口 | 最小 980×640（`src/main/index.ts`），因此桌面不会出现手机宽度 |
| 顶栏 | 42px |
| 间距 | 高频值 2 / 4 / 6 / 8 / 10 / 12px；页面级容器常见 14–18px |
| 圆角 | 现有 4 / 5 / 6 / 7 / 8 / 9 / 10 / 11 / 12 / 14 / 16 / 999 / 50%；**新代码只用 4 / 6 / 8 / 12 / 16 / 999** |
| 阴影 | 只用 `--shadow-sm` / `--shadow-md` / `none` |

`overflow: auto` 的容器（面板、列表、预览）内不要放 `position: absolute` 的浮层；浮层用 `fixed` + `createPortal(document.body)`。注意：祖先有 `transform` / `backdrop-filter` 时，`fixed` 会以该祖先为包含块——这是必须 portal 到 body 的第二个理由。

## 6. 深度与阴影

| token | 浅色 | 深色 |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(20,22,18,.06)` | `0 1px 2px rgba(0,0,0,.24)` |
| `--shadow-md` | `0 1px 2px rgba(20,22,18,.06), 0 10px 30px rgba(20,22,18,.08)` | `0 1px 2px rgba(0,0,0,.28), 0 14px 36px rgba(0,0,0,.32)` |

层级用「面板底色 + 1px 边框 + shadow-md」表达，不靠加粗边框。彩色阴影只允许用于焦点环（`0 0 0 2px var(--accent-soft)`）。

## 7. Do / Don't

**Do**

- 复用既有变量与同类组件；新增样式先找 `styles.css` 里是否已有近似规则。
- 每个交互组件给 hover / focus-visible / active（选中）/ disabled 四态。
- 长文本详情用 tooltip / 展开，不要塞进单行 ellipsis。
- 浮层坐标夹在视口内（左右上下），窄窗不溢出。
- 键盘可达：按钮可 Tab、有 `aria-label`；浮层可用焦点触发。

**Don't**

- 不写裸 hex / 裸 rgba 颜色（现状 288 种 hex、128 种 rgba，见附录 A）。
- 不新增 7 / 9 / 11px 这类相邻圆角；不新增 10.5 / 11.5px 字号（存量除外）。
- 不用原生 `title` 承载长文本（单行、延迟、不可滚动、深色下样式不可控）。
- 不在 `overflow: auto` 容器内做绝对定位浮层。
- 不为「一次性特效」引入新颜色而不加变量——下一个人会在深色主题里踩到。

## 8. 响应式

- 桌面窗口 ≥ 980×640，不需要手机断点。
- 唯一的 `@media (max-width: 760px)` 只用于 `skills-hub-layout`（技能页两栏折叠），不要在小窗口测试里把它当通用断点。
- 触摸/手写笔场景（Windows 平板）按按钮 ≥ 28px 处理；普通桌面可 24px。
- 预览面板宽度由 `--preview-w` + 拖拽控制，不要在组件里硬编码 420。

## 9. Agent Prompt Guide（改 UI 时按这个顺序）

1. **读本文第 2/4/5 节**，确认要用的 token 与同类组件。
2. `grep` 现有类名，优先复用；新增类名以组件语义命名（`.user-message-nav-tip`，不要 `.green-box`）。
3. 颜色/圆角/阴影只用第 5 节的档位与变量；需要新变量时**成对**加到浅色与深色块。
4. 写完立刻检查三件事：深色下是否成立、焦点在哪、窄窗会不会被裁。
5. 验证：`npm run typecheck` + `npm run build`；界面改动 HMR 自动生效（`logs/dev-run.log` 有 `hot updated`），主进程改动才需要 `bash scripts/restart-dev.sh`。
6. 涉及 choices 面板时同时看 `docs/CHOICES.md`（三端规则一致：桌面 / PWA / 安卓）。

**范例（本次 tooltip 的实现，可照抄结构）**：面板行悬停 → `createPortal(document.body)` 渲染 `position: fixed` 卡片 → 坐标 `Math.min(rect.right + 12, innerWidth - width - 12)` 夹取 → `maxHeight = innerHeight - top - 16` + `overflow-y: auto` → 移入卡片取消关闭定时器（120ms 宽限）→ 深色主题补一条 `.user-message-nav-tip` 覆盖。

---

## 附录 A：token 收敛清单（2026-10-27 扫描）

| 类别 | 现状 | 建议 | 优先级 |
|---|---|---|---|
| hex 颜色 | **288 种**，出现 516 次；`#fff`×79、错误色 `#c0392b`×18 / `#b23a2c`×17 居前（`#c0392b` 同时是浅色 `--ctx-hi`） | 收敛到 40 个左右变量；错误色先 token 化（`--danger` / `--danger-soft`），白色硬编码换成 `--surface` / `--bg` | P0（错误色）→ P1（其余） |
| rgba | **128 种**，出现 219 次；`rgba(0,0,0,.06)`×15、`.05`×15、`.08`×9 | 加 `--overlay-1…4`（浅色黑透明 / 深色白透明两套）与 `--ring`，替代散落透明度 | P1 |
| 圆角 | 12 档：8px×77、7px×39、10px×37、999px×34、6px×32、50%×29、5px×27、9px×25、12px×17、4px×10、11px×7、16px×6 | 定为 `--radius-xs 4` / `sm 6` / `md 8` / `lg 12` / `xl 16` / `pill 999`；存量逐步替换 | P1 |
| 字号 | 16 档：12×110、12.5×88、11×76、13×69、11.5×59、10.5×50… | 定为 `10/11/12/13/14/16/22`；`10.5/11.5/12.5/13.5` 归并 | P2 |
| 阴影 | `--shadow-sm/md` 各用 15 次，另有 8 种自定义 | 只保留 sm/md + 焦点环；`0 24px 70px rgba(0,0,0,.32)` 这类一次性值归入 md | P2 |
| 深色覆盖 | 组件级 `:root[data-theme="dark"] .x` 规则很分散 | 新组件必须成对；未来可评估 `color-mix` 减少覆盖条数 | 持续 |

> 扫描方法：对 `styles.css` 做正则统计（`#[0-9a-f]{3,8}`、`rgba?\(`、`border-radius:`、`box-shadow:`、`font-size:`、`@media`）。
> 数据是快照，改动后重跑即可对比；不要把这些数字当目标，它们只说明收敛空间。

## 附录 B：现状速查

| 项 | 值 |
|---|---|
| CSS 规模 | 11,994 行，39 个唯一变量名（含各主题/preset 覆盖） |
| 主题 | 浅色默认 / `data-theme="dark"`；`color-scheme: dark` |
| 强调色预设 | 7 组（default / green / red / blue / white / lightgray / darkgray），每组浅+深 |
| 唯一断点 | `@media (max-width: 760px)`（仅 skills-hub） |
| 窗口 | 最小 980×640 |
| 字体回退 | 系统字体优先，中文回退 PingFang / 微软雅黑 / 冬青黑 |

<!-- created=2026-10-27, 依据 styles.css 全量扫描；改本文件时同步更新附录 A 的日期与数字 -->

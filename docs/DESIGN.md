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

### 2.3 语义色

| 语义 | 变量 | 浅色 / 深色 | 用途 |
|---|---|---|---|
| 错误 / 危险（文字、边框、小圆点） | `--danger` | `#c0392b` / `#f2726a` | 工具错误、搜索无结果、测试失败、到期提醒、录音状态 |
| 危险按钮 / 横幅底（白字） | `--danger-strong` | `#b23a2c` / `#c0392b` | `.btn.danger`、停止按钮、`toast.error`、陈旧横幅 |
| 危险按钮 hover | `--danger-strong-hover` | `#922d24` / `#d8493c` | `.btn.danger:hover` |
| 浅底（错误输入 / 缺题 / 警告条） | `--danger-pale` / `--danger-pale-strong` | `#fdf3f1` / `#fbe9e7`（深色为半透明红） | 错误输入框、缺题标记、danger hover 底 |
| 半透明红（底 / 环 / 边框） | `--danger-soft` / `--danger-soft-hover` / `--danger-ring` / `--danger-border` | `rgba(192,57,43,.08/.16/.28)` + `#ecc`（深色为亮红半透明） | hover 底、focus ring、错误边框 |
| 上下文用量 | `--ctx-warn` / `--ctx-mid` / `--ctx-hi` | `#ca8a04` / `#d97706` / `#c0392b`（深色独立一套） | 进度条与百分比 |
| 成功 / 在线 | `--accent` | 见 §2.1 | — |

**规则**：新代码只引用变量。`--ctx-hi` 与 `--danger` 浅色同值但语义不同，保留两份。
尚未收敛的红/橙变体（`#c64d42` / `#d64545` / `#e05555` 等 diff/告警色、accent 预设的 `#ff3b30`/`#ff453a`）属于其他语义，下一批处理。

## 3. 排版

| 项 | 现状 |
|---|---|
| 正文字体 | `--font`：`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif` |
| 等宽 | `--mono`：`ui-monospace, "Cascadia Code", "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", monospace` |
| 基准 | `body` 14px / 1.55；markdown 正文 14.5px / 1.65 |
| 字号 | ✅ 已收敛为 7 档：`10`(25) / `11`(107) / `12`(216) / `13`(74) / `14`(19) / `16`(12) / `22`(7)；`8px` 仅 1 处（`.msg-artifact-icon` 图标徽标）作例外保留；`clamp()` / `em` / `inherit` 不动 |
| 字重 | 400 / 500 / 600 / 650 / 700（650 用于「当前选中」类强调） |

**字号规则**：新代码只能在这 7 档里选；不要再写 `10.5 / 11.5 / 12.5 / 13.5`。
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
| 圆角 | 已收敛为 6 档：`--radius-xs 4` / `--radius-sm 8` / `--radius-md 10` / `--radius 12` / `--radius-xl 16` / `--radius-pill 999`；`50%`（圆形）与 `2px`（几何胶囊）保留字面量，复合圆角用变量拼 |
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
| hex 颜色 | **283 种**，出现 467 次；`#fff`×79 居首（危险色家族已收敛，见下） | 继续收敛白色硬编码到 `--surface` / `--bg`；diff/告警红色变体下一批 | P1 |
| **危险色家族** | ✅ 已收敛：`--danger` / `--danger-strong` / `--danger-strong-hover` / `--danger-pale(-strong)` / `--danger-soft(-hover)` / `--danger-ring` / `--danger-border`（浅深各一套，共 9 个变量） | 新错误/危险样式一律用这套；深色下自动变亮红 | **已完成** |
| 半透明覆盖层 | ✅ 已收敛：`--overlay-1…8`（浅色 = 黑透明 `.02/.045/.06/.085/.15/.26/.52/.9`；深色 = 白透明 `.04/.07/.10/.14/.20/.30/.55/.92`），替换 **87 处** hover/选中底与深色覆盖 | 新代码用 overlay，不再写 `rgba(0,0,0,α)` / `rgba(255,255,255,α)`；遮罩（`.modal-backdrop`）保持原样 | **已完成** |
| rgba（剩余） | **113 种**，出现 146 次；剩下的是阴影（`.32`×5）、品牌色半透明（`rgba(79,91,77,.18)` 等）与少量单行规则 | 阴影走 `--shadow-*`；品牌色半透明按语义单独 token 化 | P2 |
| **圆角** | ✅ 已收敛：6 档 `4/8/10/12/16/999`（替换 304 处：300 单值 + 4 复合），另保留 `50%`（29 处圆形）与 `2px`（4 处几何胶囊）；相邻档 1–2px 归并（6/7→8、9→10、5→4、11→12、13/14→12） | 新代码只用这 6 档 + `50%`；不要再写 7/9/11px | **已完成** |
| **字号** | ✅ 已收敛：7 档 `10/11/12/13/14/16/22`（归并 196 处）；半像素档与 15/17/18/19/20/24/25 就近归并；保留 8px×1（图标徽标）、2 处 `clamp()`、1 处 `em` | 新代码只在这 7 档里选 | **已完成** |
| 阴影 | `--shadow-sm/md` 各用 15 次，另有 8 种自定义 | 只保留 sm/md + 焦点环；一次性值归入 md | P2 |
| 深色覆盖 | 组件级 `:root[data-theme="dark"] .x` 规则很分散 | 新组件必须成对；未来可评估 `color-mix` 减少覆盖条数 | 持续 |

> 扫描方法：对 `styles.css` 做正则统计（`#[0-9a-f]{3,8}`、`rgba?\(`、`border-radius:`、`box-shadow:`、`font-size:`、`@media`）。
> 数据是快照，改动后重跑即可对比；不要把这些数字当目标，它们只说明收敛空间。

## 附录 B：现状速查

| 项 | 值 |
|---|---|
| CSS 规模 | 12,000+ 行，60 个唯一变量名（含各主题/preset 覆盖） |
| 主题 | 浅色默认 / `data-theme="dark"`；`color-scheme: dark` |
| 强调色预设 | 7 组（default / green / red / blue / white / lightgray / darkgray），每组浅+深 |
| 唯一断点 | `@media (max-width: 760px)`（仅 skills-hub） |
| 窗口 | 最小 980×640 |
| 字体回退 | 系统字体优先，中文回退 PingFang / 微软雅黑 / 冬青黑 |

<!-- created=2026-10-27, 依据 styles.css 全量扫描；改本文件时同步更新附录 A 的日期与数字 -->

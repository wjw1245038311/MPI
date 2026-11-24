---
# MPI 设计 token（机器可读段）
# 来源：src/renderer/src/styles.css 的 :root（2026-11-24 实测）
# 规则：agent 写 UI 时只能引用下面列出的值；不在表里的值一律视为违规。
# 与 docs/DESIGN.md 的关系：本文件是「值 + 校验规则」，DESIGN.md 是「为什么 + 怎么用」。
name: MPI Desktop
version: 1.0.0
updated: 2026-11-24

colors:
  # 角色 → 变量名。禁止裸值（见 strict.forbidden）。
  background: "--bg"
  rail: "--rail"
  rail_solid: "--rail-solid"
  rail_2: "--rail-2"
  surface: "--surface"
  surface_muted: "--surface-muted"
  border: "--border"
  border_strong: "--border-strong"
  text: "--text"
  text_dim: "--text-dim"
  text_faint: "--text-faint"
  accent: "--accent"
  accent_soft: "--accent-soft"
  warn: "--warn"
  warn_soft: "--warn-soft"
  action: "--send"
  action_hover: "--send-hover"
  action_fg: "--send-fg"
  control: "--control"
  control_hover: "--control-hover"
  code_bg: "--code-bg"
  user_bubble: "--user-bubble"
  danger: "--danger"
  danger_strong: "--danger-strong"
  danger_strong_hover: "--danger-strong-hover"
  danger_pale: "--danger-pale"
  danger_pale_strong: "--danger-pale-strong"
  danger_soft: "--danger-soft"
  danger_soft_hover: "--danger-soft-hover"
  danger_ring: "--danger-ring"
  danger_border: "--danger-border"
  overlay_1: "--overlay-1"   # 最浅，hover 底
  overlay_2: "--overlay-2"
  overlay_3: "--overlay-3"
  overlay_4: "--overlay-4"
  overlay_5: "--overlay-5"
  overlay_6: "--overlay-6"
  overlay_7: "--overlay-7"
  overlay_8: "--overlay-8"
  hairline: "--hairline"
  scrim: "--scrim"
  scrim_soft: "--scrim-soft"

typography:
  # 7 档。fullPx 是字号，usage 是「什么时候用」—— 光有这个值不够，usage 才是 agent 决策依据。
  scale:
    - { token: "--fs-10", fullPx: 10, usage: "徽标、极小元信息（图标内文字）。慎用，低于此不成立" }
    - { token: "--fs-11", fullPx: 11, usage: "辅助元信息、键位提示、紧凑徽标" }
    - { token: "--fs-12", fullPx: 12, usage: "列表行次要文字、标签、按钮小号" }
    - { token: "--fs-13", fullPx: 13, usage: "面板标题、表单标签、紧凑正文" }
    - { token: "--fs-14", fullPx: 14, usage: "默认正文（body 基准）" }
    - { token: "--fs-16", fullPx: 16, usage: "区块标题、卡片标题" }
    - { token: "--fs-22", fullPx: 22, usage: "页面级标题，全应用不超过 7 处" }
  weights: [400, 500, 600, 650, 700]
  fonts:
    ui: "--font"
    mono: "--mono"

spacing:
  # 高频值。页面级容器允许 14–18，其余只用这几档。
  scale: [2, 4, 6, 8, 10, 12]
  page_container: [14, 16, 18]

rounded:
  scale:
    - { token: "--radius-xs", fullPx: 4 }
    - { token: "--radius-sm", fullPx: 8 }
    - { token: "--radius-md", fullPx: 10 }
    - { token: "--radius", fullPx: 12 }
    - { token: "--radius-xl", fullPx: 16 }
    - { token: "--radius-pill", fullPx: 999 }
  literals_allowed: ["50%", "2px"]   # 50% = 圆形；2px = 几何胶囊（仅 4 处）

depth:
  shadow_sm: "--shadow-sm"
  shadow_md: "--shadow-md"
  shadow_lg: "--shadow-lg"
  ring: "--ring-accent"

layout:
  sidebar_w: "--sidebar-w"      # 286px
  preview_w: "--preview-w"      # 420px，可拖拽
  titlebar_h: "--titlebar-h"    # 42px
  window_min: [980, 640]

strict:
  # 这一块是「可校验规则」。人看觉得啰嗦，agent 看是硬约束。
  forbidden:
    - id: raw-hex
      rule: "不写裸 hex 颜色。所有颜色走 var(--*)"
      example_bad: 'style={{ color: "#c0392b" }}'
      example_good: 'style={{ color: "var(--danger)" }}'
    - id: raw-rgba
      rule: "不写裸 rgba()。半透明一律用 --overlay-1…8 / --danger-soft / --hairline / --scrim"
    - id: off-scale-font
      rule: "字号只能取 typography.scale 的 7 档，禁止 10.5 / 11.5 / 12.5 / 13.5 / 15px"
    - id: off-scale-radius
      rule: "圆角只能取 rounded.scale 的 6 档（+ 50% / 2px），禁止 5px / 7px / 9px / 11px"
    - id: dark-theme-missing
      rule: "新增样式必须成对提供 :root[data-theme='dark'] 覆盖，否则深色下是亮色块"
    - id: absolute-in-scroll
      rule: "不在 overflow:auto 容器里放 position:absolute 浮层；用 createPortal(document.body) + position:fixed"
    - id: single-state-component
      rule: "交互组件必须给 hover / focus-visible / active / disabled 四态"
  required:
    - id: one-accent-action
      rule: "一屏只有一个主操作使用 --send（或 --accent）。其余动作用 ghost / 次级样式"
    - id: token-pair
      rule: "新增变量必须成对写入浅色与深色两个 :root 块"
    - id: state-matrix
      rule: "新交互组件必须在 docs/UI-SPEC.md 的状态矩阵里列出全部状态（见该文件 §2）"
---

# MPI 设计 Token（真相源）

> 面向：写 `src/renderer/**` 样式的人和 agent。
> **本文件是值的真相源**；`docs/DESIGN.md` 是「为什么这样设计 + 怎么用」的取向说明。
> 数据来源：`src/renderer/src/styles.css`（12,499 行，2026-11-24 实测）。

## 0. 怎么用这份文件（给 agent 的强制顺序）

1. **先读 front matter 的 `strict` 块** —— 那里是禁止清单，比你读 design 原理更管用。
2. 选值只能从 front matter 的 `colors` / `typography.scale` / `rounded.scale` / `spacing.scale` 里挑。
3. 需要新值 → **先问，不要自己加**。新增必须成对写浅色 + 深色，并补进本文件 front matter。
4. 写完自检三条：深色下成立吗？焦点在哪？980px 窄窗溢出吗？
5. 交互组件还要过 `docs/UI-SPEC.md` 的状态矩阵。

## 1. 现状实测（2026-11-24）

这些数字**不是目标，是基线**。改完重跑脚本对比，不要为了凑数字而改。

| 项 | 实测值 | 说明 |
|---|---|---|
| CSS 总行数 | **12,499** | 单文件 |
| 裸 hex 种类 | **300** | `#[0-9a-fA-F]{3,8}` 去重（2026-10-27 快照是 283，一个月涨了 17） |
| rgba 种类 | **110** | 已收敛过一轮，剩一次性语义值 |
| 深色覆盖规则数 | **269** | `:root[data-theme="dark"]` 出现次数 |
| 字号档位实际使用 | 8/10/**10.5**/11/**11.5**/12/**12.5**/13/**13.5**/14/**15**/16/22 | **粗体是离档值，共 42 处** |
| 圆角字面量 | 2/4/**5**/**7**/8/10/12/999 | **粗体是离档值，共 9 处** |

### 1.1 已知离档清单（待收敛，不在本次改动范围）

```text
字号离档 42 处：
  10.5px × 9    11.5px × 17   12.5px × 11   13.5px × 2   15px × 3
  分布：主要集中在 .test-*（测试面板）、.zhiya-*（知芽面板）、
        .choices-*（选项面板）三段，是较新功能没跟规范。

圆角离档 9 处：
  5px × 4   7px × 4   2px × 1（保留）   另 2px×3 在用
  分布：同上三段 —— .zhiya-sec-head / .zhiya-kb-list / .zhiya-loc 等。
```

**收敛建议**（下次动到这些模块时顺手做，不要单开任务）：
- `10.5px → 10px`、`11.5px → 11px`、`12.5px → 12px`、`13.5px → 13px`、`15px → 16px`
- `5px → 4px`、`7px → 8px`

### 1.2 违反严格规则的实际样本（已核实）

> 依据：`strict.forbidden[raw-hex]`。这些是**违反本文件规则**的现存代码，不是我的推测。

| 文件:行 | 代码 | 应为 |
|---|---|---|
| `components/Chat.tsx:1986` | `style={{ color: "#c0392b" }}` | `var(--danger)` |
| `components/RemotePanel.tsx:259` | `style={{ color: "#c0392b" }}` | `var(--danger)` |
| `components/RemotePanel.tsx:417` | `style={{ color: "#c0392b" }}` | `var(--danger)` |
| `components/RemotePanel.tsx:369` | `style={{ color: "#b26a00" }}` | 需新增 `--warn` token（当前无告警色变量） || `components/ServerPanel.tsx:228` | `style={{ color: "#c0392b" }}` | `var(--danger)` |
| `components/Settings.tsx:3457` | `style={{ color: "#c0392b" }}` | `var(--danger)` |

内联 hex 计数（`components/*.tsx`，含图标色）：`FileTypeIcon.tsx` 41、`Settings.tsx` 16、
`RemotePanel.tsx` 3、`ServerPanel.tsx` 2、`TerminalPanel.tsx` 2、`Chat.tsx` 1、`TuiView.tsx` 1。
> `FileTypeIcon` 的 41 种是文件类型品牌色（PDF 红 / Word 蓝…），**属于允许的例外**，建议单独在
> 本文件加一个 `exceptions.file-type-brand-colors` 段说明，而不是硬判违规。

> **2026-11-24 更新**：`RemotePanel.tsx` 的 3 处（含 `#b26a00`）**已全部改为 token**，
> 并新增 `--warn` / `--warn-soft`（浅 `#b26a00` / 深 `#e08a3c`）。
> 现在该文件的内联裸色计数为 **0**，可作为「收敛一个文件」的样板。
> 剩余 5 处（Chat / ServerPanel / Settings）待收敛，用 `.set-diag-err` / `var(--danger)` 替即可。

**顺带发现一个 token 缺口**：`#b26a00`（告警橙）在 `styles.css` 里没有对应的变量，
`--ctx-warn` 是同色系但语义是「上下文用量」。**建议新增 `--warn` / `--warn-soft` 成对变量**——
这是本文件发现的真实缺口，不是编的。

## 2. 语义层与视觉层的分工（为什么不能只有 hex 表）

> 依据：Figma「LLM Context Design」与 DesignSystems.one 的共同结论 ——
> **token 说值是什么，prose 说什么时候用；只有值，会出现「正确的蓝用在错误的地方」。**

所以本文件 front matter 里每个 token 都带了 `usage`。**没有 usage 的 token 不要写进来**——
列裸值不写用途，等于给 agent 一把没标签的零件。

三层结构（本文件用前两层）：

```
原始层 primitive   #2e7d52          ← 只有 styles.css 里出现
语义层 semantic    --accent          ← agent 应该引用这一层
组件层 component   --send / --user-bubble  ← 已有，按语义命名
```

现存的问题是**第三层混进了语义含义**：`--send` 字面是「发送按钮」，实际是「主操作」。
不影响使用（全部主操作确实都是发送/提交），但新组件想复用时要意识到这一点。

## 3. 硬规则的执行方式（不靠自觉）

规则写了不看等于没写。现有可用手段：

| 手段 | 现状 | 建议 |
|---|---|---|
| `npm run typecheck` | ✅ 已有 | 抓不到样式违规 |
| 正则扫描 | ✅ 可手工跑 | 本文件 §1 的数字就是这么来的 |
| stylelint | ❌ 无 | **性价比最高的补充**：`color-no-hex` + `declaration-property-value-allowed-list` |
| 视觉回归 | ❌ 无 | 见 `docs/UI-SPEC.md` §5 |

**立即可用的扫描命令**（复制粘贴即可）：

```bash
# 内联裸 hex（排除 FileTypeIcon 品牌色）
grep -rnoE 'style=\{\{[^}]*#[0-9a-fA-F]{3,8}' src/renderer/src/components/*.tsx | grep -v FileTypeIcon

# 离档字号
grep -cE "font-size: *(10\.5|11\.5|12\.5|13\.5|15)px" src/renderer/src/styles.css

# 离档圆角
grep -nE "border-radius: *(5|7|9|11)px" src/renderer/src/styles.css

# 裸 hex 种类数（趋势监控）
grep -oE "#[0-9a-fA-F]{3,8}" src/renderer/src/styles.css | sort -u | wc -l

# 花括号配平（两份都应为 0 / 0）
# ⚠️ 必跑：npm run build 与 typecheck **都不报 CSS 括号失衡**（2026-11-24 实测：
# mobile/pwa/src/styles.css 少一个 `}`，构建全绿，但后面的规则被整块吞掉，
# 抽屉直接失去 position: fixed，掉进页面正常流里）。
for f in src/renderer/src/styles.css mobile/pwa/src/styles.css; do node -e "
const s=require('fs').readFileSync('$f','utf8');
let d=0,min=0; for(const c of s){ if(c==='{')d++; if(c==='}'){d--; if(d<min)min=d;} }
console.log('$f', '末尾深度:', d, '最负:', min);
"; done
```

> 只改了一个 CSS 块之后，**先看一眼整体布局还在不在原位**再看细节：
> 括号失衡的典型症状不是报错，而是某块样式「静默失效」（定位、层级、主题变量丢失）。

## 4. 与 DESIGN.md 的分工（避免两份文档打架）

| 文件 | 负责 | 谁读 |
|---|---|---|
| **本文件** `DESIGN-TOKENS.md` | 值是什么 + 什么算违规（可校验） | agent 先读这个 |
| `DESIGN.md` | 为什么这样设计、组件长什么样、设计取向 | agent 写样式时读 |
| `UI-SPEC.md` | 交互状态与验收标准 | agent 写交互时读 |

**冲突时以本文件的值为准**；DESIGN.md 里出现裸值的地方（如「圆角 7–8px」）按本文件的 8px 执行。

## 5. 变更记录

| 日期 | 版本 | 变更 | 依据 |
|---|---|---|---|
| 2026-11-24 | 1.0.0 | 首版：token 表 + strict 规则块 + 实测基线 | `styles.css` 全量扫描（12,499 行） |

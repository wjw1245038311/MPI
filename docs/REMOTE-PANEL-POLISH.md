# 远程控制面板 · 视觉优化方案（可交本地模型逐步执行）

面向「设置 → 手机远程控制」这个面板（`RemotePanel`），目标：**看着整齐、有图标、层次清楚**。
本文件是给执行者（人或本地模型）的工单：每步都可独立完成、独立验证，互不阻塞。

## 0. 约束（先读，避免踩坑）

- 只改**样式与 JSX 结构**，**不要碰**任何 IPC 调用、状态机、协议或加密逻辑。
- **不新增依赖**。图标一律手写 SVG，风格照 `icons.tsx` 现有条目：`viewBox="0 0 24 24"`、
  `fill="none"`、`stroke="currentColor"`、`strokeWidth={1.7}`、圆头圆角，尺寸由 `size` 属性给。
- 纯渲染层改动，改完 `Ctrl+R` 即可看到；**每步之后跑一次 `npm run typecheck`**。
- 不要在 `.set-card` 内部渲染 `position: fixed` 元素（`styles.css` 里有注释警告：卡片 hover 的
  `transform` 会成为它们的包含块，弹层会跳）。
- 通用验收：桌面 MPI → 设置 → 手机远程控制，逐条对照每步的「验收」。

涉及文件：

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/components/RemotePanel.tsx` | 面板结构与文案 |
| `src/renderer/src/components/icons.tsx` | 图标（内联 SVG 组件） |
| `src/renderer/src/styles.css` | 样式（`.set-*` 那一大片） |
| `src/renderer/src/App.tsx` | 面板外壳（`.set-modal` / `.set-head` 标题栏，约 169 行） |

## 1. 现成积木（**优先复用，不要另造**）

| 类名 / 组件 | 作用 | 备注 |
| --- | --- | --- |
| `.set-card` | 白底卡片（圆角 12、padding 14/16、hover 微抬） | 面板里每块内容一张 |
| `.set-card-head` | **图标 + 标题**的 flex 行（gap 10） | 已用在 `Settings.tsx:812`；`RemotePanel` 完全没用 → 这就是「缺图标」的根 |
| `.set-card-title` | 卡片标题（13px 粗体，本身带 `margin-bottom: 8px`） | 放进 `.set-card-head` 后需要把 margin 归零 |
| `.set-hint` | 说明文字（小字、弱色） | 长段说明一律用它，别用裸 `<div>` |
| `.set-btn` / `.set-btn.primary` / `.set-btn.ghost` | 按钮三态 | 主操作 primary，次要 ghost |
| `.set-adv-toggle` + `.set-adv-body` | **折叠的高级区**（`›` 旋转） | 已用在设置页；用来收「信令/WebRTC」这类遗留配置 |
| `.set-remote-status` / `.set-remote-status-value` / `.set-remote-status-dot` | 状态行（圆点 + 文案） | 现有类，可复用做摘要行 |
| `.set-remote-toggle-row` / `.set-toggle` / `.set-toggle-knob` | 开关行 | 现成 |
| `.set-input` | 输入框 | 现成 |
| `icons.tsx` 已有 | `Smartphone` `Download` `Plug` `Refresh` `Copy` `Check` `Info` `Shield` `Bell` `Gauge` `Zap` `Terminal` … | 直接 import |

缺少两个图标（S1 里给 SVG）：**`QrCode`**（配对卡）、**`Cloud`**（云中继卡）。

## 2. 现状问题（按位置，供对照）

1. **无图标**：`RemotePanel.tsx` 里 `<svg|Icon` 出现 0 次；每张卡只有文字标题，面板外壳
   `App.tsx` 的 `.set-head` 也只有 `<h2>` + `×`。（→ S1）
2. **标题重复**：弹窗外壳已写「Android 手机远程控制」，第一张卡又叫「Android 手机远程控制」。（→ S2）
3. **层级不分**：WebRTC/信令（现在实际不用）、云中继、App 下载、配对、设备列表**全是同一种卡片**
   平铺，用户最想做的「装 App → 扫码配对」被埋在第 5、6 张卡。（→ S2）
4. **说明文字过长**：多段 2–3 行的技术说明（「WSS 信令和 STUN 直连 WebRTC…」「中继只转发不解析，
   E2E 加密（S3）…」）与操作控件同级，读起来累。（→ S2）
5. **二维码规格不统一**：下载卡两张 **172px**、配对卡 **260px**，白底 padding 也不一致；下载卡用
   `flex-wrap` 并排、配对卡是 `column` 左对齐 → 卡片高度参差、重心偏左。（→ S3）
6. **配对卡信息过载**：二维码 + 一整行等宽长链接 textarea + 指纹 + 勾选框挤在一张卡里；用户已
   明确「不用显示地址」。（→ S3）
7. **配对没有时间反馈**：票据 5 分钟过期（`pairing.expiresAt` 有值但没渲染），也没有「重新生成 /
   取消」按钮，过期了只能关掉重开。（→ S3）
8. **表单零散**：输入框与按钮用 inline `style={{ marginTop: 10 }}` 逐个微调；「保存并重连」与输入框
   分两行，浪费高度。（→ S4）
9. **无空态/加载态**：二维码生成前卡片突然长高（布局跳动）；没有已配对设备时是一片空白。（→ S5）

## 3. 工单（建议按顺序做，S1 收益最大）

### S1 卡片统一「图标 + 标题」头（约 15 分钟）

**a. `icons.tsx` 末尾追加两个图标：**

```tsx
export const QrCode = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <path d="M14 14h3v3h-3zM20 14v2M20 20h1M14 20h3" />
  </svg>
);
export const Cloud = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 18h9.5a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 7.6 9.6 3.7 3.7 0 0 0 7 18Z" />
  </svg>
);
```

**b. `styles.css` 在 `.set-card-title` 后面补两条规则**（新增类，别改旧行为）：

```css
/* 卡片头里的图标徽标：小方块 + accent 色，视觉上把标题「钉」在左侧 */
.set-card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 7px;
  background: var(--accent-soft);
  color: var(--accent);
}
.set-card-head .set-card-title {
  margin-bottom: 0;
}
```

**c. `RemotePanel.tsx`：每张卡的标题行改成**

```tsx
<div className="set-card-head">
  <span className="set-card-icon"><Smartphone size={14} /></span>
  <div className="set-card-title">{zh ? "…" : "…"}</div>
</div>
```

图标分配（照用即可）：

| 卡片 | 图标 |
| --- | --- |
| 概览 / Android 手机远程控制 | `Smartphone` |
| 手机 App（安卓） | `Download` |
| 配对手机 | `QrCode` |
| 待批准设备 | `Bell` |
| 已配对设备 | `Check` |
| 手机版云中继（PWA） | `Cloud` |
| 信令配置 | `Plug` |

**d. 面板外壳标题也配上图标**（`App.tsx` 约 169 行；该文件第 18 行已有
`import { Folder, Plus } from "./components/icons";`，把 `Smartphone` 加进去）：

```tsx
<h2><Smartphone size={16} style={{ verticalAlign: "-3px", marginRight: 8 }} />
  {language === "zh" ? "Android 手机远程控制" : "Android remote companion"}</h2>
```

**验收**：每张卡标题左侧出现 accent 色小方块图标；标题与图标垂直居中；无类型错误。

### S2 重排层级：把用户要做的事放最上面（约 20 分钟）

目标顺序（自上而下）：

1. **状态摘要卡**（一行看全：中继状态 · 已配对 N 台 · App 版本）
2. **手机 App（安卓）**（装 App）
3. **配对手机**（扫码配对）
4. **待批准设备**（有内容时才渲染）
5. **已配对设备**
6. **高级**（`.set-adv-toggle` 折叠）：手机版云中继（PWA）+ 信令配置 + 各连接状态详情

做法：

- 删除第一张「Android 手机远程控制」卡的标题与长说明，把它压缩成摘要卡：

```tsx
<div className="set-card">
  <div className="set-card-head">
    <span className="set-card-icon"><Smartphone size={14} /></span>
    <div className="set-card-title">{zh ? "状态" : "Status"}</div>
  </div>
  <div className="set-remote-status">
    <span className="set-diag-k">{zh ? "中继" : "Relay"}</span>
    <span className={`set-remote-status-value ${statusClass(relayStatus?.state || "disabled")}`}>
      <span className="set-remote-status-dot" aria-hidden="true" />
      {statusLabel(relayStatus?.state || "disabled", zh)}
    </span>
    <span className="set-diag-k" style={{ marginLeft: 14 }}>{zh ? "已配对" : "Paired"}</span>
    <span className="set-remote-status-value">{status?.devices.length ?? 0} {zh ? "台" : ""}</span>
  </div>
</div>
```

- 把「信令配置」与「手机版云中继（PWA）」两张卡的**内容**（不是标题文字）搬进高级区。
先在组件顶部加一个折叠状态：`const [adv, setAdv] = useState(false);`

```tsx
<button className="set-adv-toggle" onClick={() => setAdv((v) => !v)}>
  <span style={{ transform: adv ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .15s" }}>›</span>
  {zh ? "高级：云中继与信令（WebRTC 遗留）" : "Advanced: relay & signalling"}
</button>
{adv && <div className="set-adv-body">{/* 原来那两张卡的内容，去掉外层 .set-card */}</div>}
```

- 每张卡的 `.set-hint` **压到 1 行以内**；必须保留的长解释改成 `title={...}` 悬停提示，
  或整段挪进高级区。

**验收**：打开面板先看到「状态 / 手机 App / 配对手机」三块；信令相关默认收起；没有任何一段说明超过两行。

### S3 二维码统一规格 + 配对卡重排（约 25 分钟）

**a. 统一生成入口**（`RemotePanel.tsx` 顶部，替换现有两处 `QRCode.toDataURL` 调用）：

```tsx
const QR_SIZE = 160;
const makeQr = (text: string) =>
  QRCode.toDataURL(text, {
    width: QR_SIZE,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#12141a", light: "#ffffff" },
  });
```

**b. 统一样式**（`styles.css`，替换现有 `.set-app-qrs` / `.set-app-qr` 那几条）：

```css
/* 二维码统一容器：等宽栅格，避免两张码尺寸不一、卡片高度参差 */
.set-qr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 14px;
  margin-top: 12px;
}
.set-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.set-qr img {
  width: 160px;
  height: 160px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: #fff;
}
.set-qr-label {
  font-size: 12px;
  color: var(--text-dim);
}
```

**c. 下载卡**：两张码放进同一个 `.set-qr-grid`，标签用 `.set-qr-label`
（「中继（推荐）」「GitHub（备选）」），地址仍只放在 `img` 的 `title` 上。

**d. 配对卡改成左右两栏**（`styles.css` 加）：

```css
.set-pair-split {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 16px;
  align-items: start;
  margin-top: 12px;
}
```

结构：

```tsx
<div className="set-pair-split">
  <div className="set-qr">{qr && <img src={qr} alt={...} title={pairingUri(pairing)} />}</div>
  <div>
    <div className="set-hint">{zh ? `票据剩余 ${mmss} 后失效` : `Ticket expires in ${mmss}`}</div>
    <div className="set-diag-btns">
      <button className="set-btn ghost" onClick={createPairing}>{zh ? "重新生成" : "Regenerate"}</button>
      <button className="set-btn ghost" onClick={() => { setPairing(null); setQr(null); }}>{zh ? "取消" : "Cancel"}</button>
    </div>
    <details>
      <summary className="set-hint">{zh ? "无法扫码？显示链接" : "Can't scan? Show link"}</summary>
      <textarea className="set-input" rows={3} readOnly value={pairingUri(pairing)} />
      <div className="set-hint">{zh ? `指纹：${pairing.fingerprint}` : `Fingerprint: ${pairing.fingerprint}`}</div>
    </details>
    <label className="set-check">
      <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
      <span>{zh ? "扫码后自动批准" : "Auto-approve after scan"}</span>
    </label>
  </div>
</div>
```

**e. 倒计时**（新增 state + effect，纯前端，不碰 IPC）：

```tsx
const [now, setNow] = useState(Date.now());
useEffect(() => {
  const t = window.setInterval(() => setNow(Date.now()), 1000);
  return () => window.clearInterval(t);
}, []);
const remainingMs = pairing ? Math.max(0, pairing.expiresAt - now) : 0;
const mmss = `${String(Math.floor(remainingMs / 60000)).padStart(2, "0")}:${String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, "0")}`;
```

**验收**：两张下载码与配对码尺寸一致（160px）、带描边、不刺眼；配对卡左右分栏，看不到长链接
（除非展开「无法扫码？」）；出现 mm:ss 倒计时，归零后按钮仍可点「重新生成」。

### S4 表单与按钮统一（约 15 分钟）

- 删掉所有 `style={{ marginTop: … }}`，改由样式控制：

```css
.set-card .set-input + .set-btn,
.set-card .set-inline-row { margin-top: 10px; }
.set-inline-row {
  display: flex;
  gap: 10px;
  align-items: center;
}
.set-inline-row .set-input { flex: 1; }
```

- 「信令地址 + 保存并重连」并成一行 `.set-inline-row`；输入框用 `.set-input`（去掉复用的
  `.set-addprov-field wide`，或给它补一条 `flex: 1` 规则）。
- 次要动作（重连、刷新、复制）统一 `.set-btn.ghost`。

**验收**：面板里搜不到 `style={{ marginTop`；同一行内的输入框与按钮高度对齐。

### S5 空态与加载态（约 15 分钟）

- 二维码未就绪时占位，避免跳动：

```css
.set-qr-skeleton {
  width: 160px;
  height: 160px;
  border-radius: 10px;
  background: repeating-linear-gradient(45deg, #f2f3f7 0 10px, #e9ebf2 10px 20px);
}
```

- 无已配对设备时空态：

```tsx
{!status?.devices.length && (
  <div className="set-empty">
    <Check size={22} />
    <span>{zh ? "还没有配对设备" : "No paired devices yet"}</span>
  </div>
)}
```

```css
.set-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 0;
  color: var(--text-faint);
  font-size: 12.5px;
}
```

**验收**：打开面板不再有二维码出现时的布局跳动；设备为空时显示图标 + 一句提示。

### S6 细节加分（可选，约 15 分钟）

- 状态圆点在 `connecting` 时轻微呼吸：

```css
@keyframes set-dot-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
.set-remote-status-value.connecting .set-remote-status-dot { animation: set-dot-pulse 1.2s ease-in-out infinite; }
```

- 二维码出现时淡入：`.set-qr img { animation: set-fade-in .18s ease-out }` + `@keyframes set-fade-in { from { opacity: 0 } to { opacity: 1 } }`。
- 卡片头图标 hover 时轻微放大（`transition: transform .15s`）。

## 4. 回归清单（每步之后都过一遍）

1. `npm run typecheck` 通过。
2. 面板能开能关；`×` 正常。
3. 复制 `mpi://` 链接、点「生成配对二维码」、扫码配对仍工作（不要动这些逻辑）。
4. 「手机 App」两张码仍在，`title` 里还有地址。
5. 中继断开时仍显示「中继暂不可达 + GitHub 备选」。
6. 两种主题（浅色/深色）下二维码与描边都可辨识。

## 5. 明确不要做

- 不改 `remote:*` IPC、不改 `pwa`/`relay`/`android` 任何文件。
- 不引入 UI 库 / 图标库 / CSS 框架。
- 不做「把面板改成左右分栏导航」这类结构重构——当前是弹窗里的单列卡片流，改动面太大。
- 不给 `.set-card` 加 `position: fixed` 子元素。

# 中继（ECS）可读性审计：E2E 是否真的挡得住运营者

> 日期：2026-10-19
> 范围：`mobile/relay/index.mjs`（ECS 上跑的中继）、`src/main/remote/*`（桌面主机侧）、
> `mobile/pwa/src/lib/*`（PWA 侧）、`mobile/app/.../data/Updater.kt`（安卓自更新）、
> `src/main/app-updater.ts`（桌面自更新）。
> 结论依据分两类，文中逐条标注：**【已验证】** = 读过源码 / 跑过 PoC / 查过生产机；**【未验证】** = 仅推断。
> 本次审计**未改动生产环境**（ECS 上的中继进程、静态站、systemd 配置均未变更）。

## 一、结论摘要

| # | 问题 | 中继能否拿到明文对话 | 等级 |
|---|---|---|---|
| A | **配对握手不认证主机身份**，中继可冒充主机完成 MITM | **能**（PoC 已跑通） | P0 |
| B | **客户端代码由中继分发**（PWA 静态站 / APK 清单 / 桌面 `latest.yml`） | **能**（无需破密码学） | P0 |
| C | 附件应用层加密是**可选**的（`X-MPI-Enc`） | 能（明文过中继） | P1 |
| D | 中继日志记录每条帧的大小与流向 | 只泄露元数据，非内容 | P2 |
| E | 推送文案明文经中继 | 当前只有固定文案 + `threadId` | P2 |

一句话：**「内容加密这层已经够了」这个判断不成立**——链路是加密的，但没有建立「对中继的主机身份认证」，
所以中继不需要破 AES，只要在握手时递上自己的公钥即可。

## 二、中心问题：配对握手缺少身份绑定

### 2.1 设计意图（文档口径）

`docs/RELAY-SHARING.md` §一 写明信任模型：「你（中继运营者）看不到消息、快照、附件字节、配对协商出的会话密钥」。
§二 标注控制通道 E2E「✅ 无差距」。`src/main/remote/pairing-proof.ts` 的注释也把 v2 的动机写成
「一个不可信的中继可以把**自己的**公钥分别塞给两端」。

v2 确实把 **X25519 公钥**绑进了签名文本，所以「换 X25519 公钥」这一招被堵住了。
但它没有把 **Ed25519 身份公钥**与 `hostId` 绑定——而签名用的正是中继递来的那把身份公钥。

### 2.2 缺陷（【已验证】：读码 + PoC）

手机端 `mobile/pwa/src/lib/pairing.ts:162-166`：

```ts
const hostPublicKeyPem = String(cp.hostPublicKeyPem ?? "");   // ← 中继给的，不是票里的
const hostSignature   = String(cp.signature ?? "");
const hostX25519Pub   = String(cp.hostX25519Pub ?? "");
if (!hostX25519Pub || !verifyHostSignature(hostPublicKeyPem, hostProofText(hostId, ...), hostSignature))
  throw new Error("主机身份校验失败（可能存在中间人）……");
```

- `verifyHostSignature` 用的是**同一帧里带来的** `hostPublicKeyPem` → 只验「签名与这把钥匙自洽」。
- 全程**没有**任何一处校验 `sha256(hostPublicKeyPem) === payload.hostId`（`hostId` 的定义就是身份公钥哈希，
  见 `src/main/remote/identity.ts` 的 `hostIdFor`）。
- 配对票里的 `hostPublicKeyPem` / `fingerprint` 虽然被 `parsePairingLink` 解析出来
  （`pairing.ts:84`），但**从未参与校验**（全仓搜索 `hostPublicKeyPem` 在 PWA 侧仅此两处）。
- `PairingRecord`（`mobile/pwa/src/lib/keystore.ts`）只存 `hostX25519PubB64u`，**不存身份公钥**，
  所以重连时也无从比对（pinning 不存在）。

### 2.3 攻击链（4 步）

1. **中继知道票**：主机生成票后主动上报 `relay.sendControl({ type:"ticket.register", ticket, expiresAt })`
   （`src/main/remote/host.ts:263`，中继 `index.mjs:838` 入表）；手机的 `pair.request` 也经中继路由
   （`index.mjs:983-1009`，中继据此查 `tickets` 表拿到 `hostId`）。票 5 分钟有效。
2. **骗手机**：中继不把主机的 `pair.challenge` 转发给手机，而是自己造一帧——`hostId` 照抄（票里有），
   `hostPublicKeyPem` / `hostX25519Pub` / `signature` 全用自己的。手机按 2.2 的校验逻辑**照单全收**【PoC 已验证】。
3. **骗主机**：中继拿同一张票，以「新设备」身份向主机发 `pair.hello`（自己的 Ed25519 + X25519）。
   主机侧 `host.ts:800` 命中 `autoApproveTickets` → **不弹确认、直接批准**
   （票在 `RemotePanel.tsx:155` 以 `createPairing(true)` 生成，注释写明「固定自动批准」；
   `host.ts:801` 的注释是「扫码免确认……默认开」）【已验证：代码路径】。
4. **居中转发**：中继与手机、与主机各持一把会话密钥，逐帧解密→重加密→转发。
   手机界面完全正常，日志上只有帧大小。

此后**长期有效**：中继已在主机上留下一条 `trustedDevices` 记录（其自有密钥对），
以后每次手机重连触发 `attachAutoReauth`（`pairing.ts:277+`）时，中继重放第 2 步即可，无需再等票。

### 2.4 PoC

`tempfile/2026-10-19-ecs-mitm/poc-relay-mitm.mjs`（临时目录，不进仓库；只用项目自身模块）。

```
[1] 手机校验通过：verifyHostSignature(中继公钥, ...) = true
[2] 中继公钥哈希 vmWfCllWDCrY… ≠ 票里 hostId g0WVm5sVyanv…，但没有代码比对这一条
[3] 手机与中继派生的 AES-256-GCM 密钥完全一致
[4] 中继解出明文： {"v":1,"id":"req-1","type":"thread.prompt","payload":{...,"text":"这是用户此刻正在输入的私密对话内容"}}
```

复现：`cd tempfile/2026-10-19-ecs-mitm && node poc-relay-mitm.mjs`（需项目内 `node_modules`）。

## 三、绕过密码学的更短路径：客户端代码由中继分发

即便修好第二节，只要**代码来源是中继**，运营者仍可让客户端自己把明文送出来。
三条都已经在生产上成立【已验证】：

| 通道 | 证据 | 后果 |
|---|---|---|
| PWA 静态站 | ECS 上 `systemctl show mpi-relay` 的 `RELAY_STATIC_DIR=/var/www/mpi-mobile`；中继 `index.mjs:91,136-154` 直接把它当静态根；该目录里有 `index.html` / `assets/` / `sw.js` | 任何以「PWA」形式配对的设备（本机 `remote-identity.json` 里有 3 条 `MPI PWA · Windows/…`）下次加载即执行中继下发的 JS → 可读 IndexedDB（`thread-cache-idb.ts` 缓存快照，单条上限 32MB）与 keystore（设备种子、`deviceToken`、`hostX25519Pub`） |
| 安卓 APK | `Updater.kt:207-209` 只校验**清单里写的** sha256，清单本身从 `…/download/mpi-android-native.json` 取，而同目录的 APK 也在 ECS | 中继换 APK + 换清单里 sha256 → 校验必然通过；安装需用户点一次系统安装器 |
| 桌面自更新 | `src/main/app-updater.ts:102-140`：`latest.yml` 从 `<镜像>/latest.yml` 取，之后交给 electron-updater（它校验的是同一份 yml 里的 sha512） | 中继换 exe + 换 yml → 桌面端「检查更新」即可植入任意代码 |

这三条的共同点：**签名/哈希校验的锚点与产物在同一台服务器上**，等于没有校验。
`docs/RELAY-SHARING.md` 已把「软件分发」列为加密解决不了的边界，但现实是它比 MITM 更容易实施，
所以修复第二节并不能单独解决问题——需要给「谁能改代码」单独设一道闸（见第五节）。

## 四、已确认「中继读不到」与「中继能看到」的部分

### 4.1 读不到（【已验证】）

- **帧内容**：手机/主机在发帧前就用 AES-256-GCM 加密（`e2e-crypto.ts` / PWA 同名模块），
  中继只做路由；生产日志里一律是 `bin 448B host→device-…`，没有任何明文。
- **磁盘**：中继不落盘任何会话数据；`/opt/mpi-relay` 下只有代码 + `certs/` + `data/`（准入/设备登记用）。
- **附件**：客户端声明加密时是应用层密文（`attachment-server.ts:196-215`，AAD 绑方向/名字/偏移/长度）。

### 4.2 能看到（元数据，【已验证】）

- `hostId` / `deviceId` / 设备名 / 在线时段 / 连接与断开时刻；
- **每一帧的字节数与方向**（`index.mjs:755,773,922,926` 等，生产 `journalctl` 可查）→ 可推断「何时在长回答、何时在传大文件」；
- 推送的 `kind/title/body/deepLink` **明文**（`relay-uplink.ts:311` → 中继 `index.mjs:897`）。
  当前 `title` 固定为「MPI 需要批准」、`deepLink` 只含 `threadId`，泄露有限；
- `threadId`（推送 deeplink + 配对流量的路由信息）；
- 服务器上还存着 VAPID 私钥（`/opt/mpi-relay/data`），即中继可向设备发任意推送；
- 附件下行未声明加密时**整段明文**（见 4.3）。

### 4.3 附件加密是可选的（【已验证】）

`attachment-server.ts:193-194` 的注释与 `:272` 的分支都写着「客户端自愿开启」；
未带 `X-MPI-Enc: v1` 的请求按明文处理。而附件公网入口是 `attachmentBaseUrl: http://47.97.28.110:10444`
（本机 `config.json`），即**经 ECS 反向隧道**。所以只要某条链路（旧客户端、PWA 某分支、安卓某分支）
没带头，字节就在 ECS 上是明文。是否所有客户端都无条件带头：【未验证，本次没有逐端核对调用点】。

## 五、修复建议

> **修复状态（2026-10-19）**：P0-1 已落地（PWA + 安卓 + 单测），其余待排期。
> - ✅ 手机校验 `sha256(hostPublicKeyPem) === 票里的 hostId`，且票内自带公钥时按值比对
>   （PWA `checkHostIdentity` / 安卓 `checkHostIdentity`）；
> - ✅ 已配对记录落盘 `hostPublicKeyPem` 并在重连时 pinning（旧记录首次重连后自动回填）；
> - ✅ 单测：`scripts/test-pwa-host-identity.mjs`（7 项）、安卓 `HostIdentityTest`（7 项）；
> - ⏳ P0-2（配对默认自动批准）、P1-1（附件强加密）、P1-2（代码分发验签）未动。
> - 注：修好 A 以后，**B 仍然是可用的旁路**——中继能改客户端代码就无需破密码学。

优先级按「代价 / 收益」排：

**P0-1 绑定主机身份（治本，改动小）✅ 已完成**
1. `pairing.ts` 校验 `sha256(hostPublicKeyPem)` 前 24 位 === `payload.hostId`（票来自扫码，属带外通道）。
2. `PairingRecord` 增字段 `hostPublicKeyPem`，重连（`reauthenticate`）时与 challenge 里的值比对，不一致直接拒绝并提示。
3. 加两条单测钉死：①中继换身份公钥 → 手机拒；②已配对主机公钥变化 → 手机拒。
   → 已落地：`scripts/test-pwa-host-identity.mjs` + `HostIdentityTest.kt`，`PairingTest` / `SessionTestBase` 的假主机也改为用「身份公钥哈希」当 `hostId`（否则夹具自己就是攻击形态）。

**P0-2 收紧配对票**
- `createPairing(true)` 改为默认 `false`（桌面弹一次确认），或至少「非首次配对必须确认」。
- `ticket.register` 不把票原文给中继（可改为一串只用于路由的哈希），中继只做路由、不认识票。

**P1-1 附件强加密**
- 服务端缺 `X-MPI-Enc: v1` 直接 400，不再静默明文；客户端先行全覆盖后再开开关。

**P1-2 代码分发设闸（问题 B，独立于 P0）**
- 最省事：安装包/前端产物做**离线签名**（如 minisign / Ed25519），公钥内置在客户端，
  客户端校验签名而不是「服务器给的哈希」。
- 退一步：让 GitHub Release / 另一台机器持有私钥，ECS 只做镜像（镜像坏了客户端仍能自己验签）。

**P2 元数据收敛**
- 帧大小日志改为聚合统计（分钟级直方图），不逐帧打印。
- 推送走真 E2E（订阅私钥留设备侧，主机用其公钥加密载荷）。

## 六、未验证 / 需要你确认的点

1. 生产上那两台主机（`m2ZkWyrf…`、`l6madOcL…`）分别是谁的机器 —— 我只读了 `hosts` 的日志行，没有枚举其内容。
2. 安卓/PWA 各端的附件上传是否**总是**带 `X-MPI-Enc`（本次未逐个调用点核对）。
3. 是否存在未走本仓代码的第三方客户端（朋友装的旧版本）——旧客户端可能不签 v2 证明，主机侧
   `MPI_ALLOW_UNBOUND_E2E` 若被打开会退回更弱模式（生产是否设置：未查）。

## 七、对照实验（修复前 vs 修复后）

脚本：`tempfile/2026-10-19-relay-mitm/`（`lab-mitm.mjs` + `mitm-proxy.mjs`，**非生产**）。
拓扑：设备 → MITM 代理 → 真中继（随机端口）→ 真主机（`RemoteHost` + `RelayUplink`）；
代理用同一张票**自己**以「新设备」身份与主机配对（票默认自动批准），同时向设备伪造 challenge。

```
[MITM] 主机腿完成：已作为「device-…」被主机自动批准
[MITM] 设备腿完成：伪造 pair.accepted，设备已与代理建立「加密」会话
[用例 1] 旧逻辑配对成功（中继已同时掌握两把密钥）
[MITM 解密] 设备→主机 {"type":"thread.prompt",…"text":"这是 minibox 用户此刻正在输入的私密对话内容"}
[用例 1] ✅ 主机侧也正常收到并处理了这条请求（用户无感知）
[用例 2] ✅ 修复后的客户端被拒：主机身份公钥与配对票不符（可能存在中间人）——已拒绝建立会话
[用例 2] ✅ 代理没有获得任何新明文（未建立设备腿）
```

结论：**修复前中继可读全部明文；修复后读不到**。

### 实验顺带暴露的残余问题

修复后，用例 2 的**主机腿依然被自动批准**（日志同样出现「已作为 device-… 被主机自动批准」）。
即：中继虽然读不到内容，但**仍能在桌面端的信任列表里静默留下一台幽灵设备**——这正面印证
P0-2（配对票默认自动批准）尚未修复：票是中继可得的，而批准不需要人确认。
另：桌面端「设置 → 远程」此时会多出一条陌生设备记录，可作为发现此类攻击的**唯一可见线索**。

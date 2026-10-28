# 凭据库与秘密执行 —— 测试方案（P1a / P1b / P1c / P2）

> 状态：**待人工验证**（L1 已全绿，L3 还没跑过） · 2026-10-28
> 设计文档：`docs/CREDENTIALS-VAULT.md` · 落地方法论：`docs/FEATURE-TESTING.md`
> 本模块的硬约束只有一句：**凭据值不得出现在对话、日志、快照、中继里**。下面所有用例都是围着这句写的。

---

## 0. 前置

1. **重启 dev**（这次改了主进程 + preload，`Ctrl+R` 不算）：`bash scripts/restart-dev.sh`
2. 建测试用凭据（**别用真密码**，用占位值如 `test-value-123`，方便 grep 取证）
3. 路径速查（`userData` = `C:\Users\<你>\AppData\Roaming\MPI Dev`）

| 产物 | 路径 | 说明 |
|---|---|---|
| 凭据库 | `<userData>/credentials.json` | 值必须是 `enc:` 开头的密文 |
| 审计 | `<userData>/credentials-audit.jsonl` | `create/update/delete/reveal/inject/exec/deny` |
| 收件箱 | `<userData>/secret-inbox/` | 扩展投递，主进程消费后**应为空** |
| 回执箱 | `<userData>/secret-outbox/` | 30 分钟后自动清扫 |
| 会话记录 | `~/.pi/agent/sessions/--E--MyWorkspace-Project-MPI--/*.jsonl` | 这里不能有明文 |
| 诊断日志 | `<userData>/logs/mpi-diag.log` | 这里不能有明文 |

**万能取证命令**（把 `test-value-123` 换成你的测试值）：

```bash
cd /e/MyWorkspace/Project/MPI
grep -rl "test-value-123" \
  "/c/Users/Administrator/AppData/Roaming/MPI Dev/credentials.json" \
  "/c/Users/Administrator/AppData/Roaming/MPI Dev/credentials-audit.jsonl" \
  "/c/Users/Administrator/AppData/Roaming/MPI Dev/logs/" \
  "/c/Users/Administrator/.pi/agent/sessions/" 2>/dev/null
# 期望：空输出（什么都不打印）。只要打印了文件路径 = 泄漏，直接判失败。
```

---

## 1. 边界表（每行都必须能被验证）

| # | 场景 | 期望行为 | 可观测判据 |
|---|---|---|---|
| B1 | 新增凭据 | 落库、列表可见 | `credentials.json` 有记录；值是 `enc:` 密文 |
| B2 | 值落盘 | 磁盘上无明文 | 万能取证命令空输出 |
| B3 | 本机加密不可用 | **拒绝保存**，绝不降级明文 | UI 提示「本机加密不可用」；文件未变 |
| B4 | 名称非法 / 重名 / 空值 | 拒绝并给稳定原因 | 界面提示对应文案 |
| B5 | 显示明文 | 15 秒后自动隐藏 | 到点自己消失 |
| B6 | 每次显示 / 复制 | 记一条 `reveal` 审计 | 审计多一行、`useCount` +1 |
| B7 | `silent` 级凭据 | 注入该会话进程环境 | agent 能读到 `$MPI_SECRET_<NAME>` |
| B8 | `confirm` / `local-only` | **不注入** | `${MPI_SECRET_X}` 为空；提示词里列为「不可用」 |
| B9 | 项目作用域的凭据 | 只在匹配项目可用 | 换项目新建会话 → 列为不可用（原因 `scope`） |
| B10 | 改级别 / 新增凭据 | 旧会话不生效，新会话生效 | 旧会话读不到；新建会话读得到 |
| B11 | `mpi_secret_run`（桌面） | 弹审批卡片 → 同意后执行 | 卡片出现；回执有输出；对话里无明文 |
| B12 | `mpi_secret_run`（拒绝） | 什么都不执行 | 卡片点拒绝 → agent 回「未执行」；审计无 `exec` |
| B13 | `local-only` + 远程来源 | 拒绝 | 回执 `DENIED_LOCAL_ONLY`；审计 `deny` |
| B14 | 命令自己 echo 了值 | 输出被替换成 `***` | 回执里有 `***` 且 `redacted` 语义 |
| B15 | 凭据名拼错 | 拒绝且说明 | 回执 `NO_CREDENTIAL` |
| B16 | 手机 / PWA | **看不到也拿不到明文** | 凭据面板在手机端无明文入口 |
| B17 | 每次会话启动 | 写一条 `inject` 审计 | 审计含注入项与被挡项及原因 |

---

## 2. L1 自动化覆盖（已注册，可直接跑）

```bash
npm run typecheck                 # 类型 / 扩展源码可编译
npm run check:ext                 # 11 个 bridge 扩展自包含性
npm test -- credentials           # logic-credentials
npm test -- secret-broker         # logic-secret-broker
npm test -- registry              # 注册表结构（新用例必须能被发现）
node scripts/test-manual-sync.mjs # changelog / 手册约定
```

| 用例 | 覆盖边界表 | 断言要点 |
|---|---|---|
| `logic-credentials` | B2/B4/B6/B7/B8/B9/B17 | 磁盘与审计无明文；重名/非法名/空值/非法级别/作用域缺 root 各自返回稳定错误码；`update` 不传 value 保留原值；`reveal` 递增计数；**加密不可用时拒绝写入且文件不变**；只有 `silent` 进注入结果；跨项目不给注入 |
| `logic-secret-broker` | B11~B15 | confirm 桌面放行；local-only 远程拒绝；无凭据 / 空命令；stdout+stderr 双向脱敏；同 id 幂等不重复执行；超时夹到 10 分钟；坏请求文件清理；超期回执清扫；审计无明文 |

**自动化覆盖不到的部分**（只能手测）：UI 卡片、审批弹窗、手机端、真实进程环境继承、Esc/关闭卡片的行为。

---

## 3. L3 真机手测清单

> 每条都写清「怎么判失败」。全部通过才算准出。

### A. 面板与 CRUD

- [ ] **A1** 设置 → 凭据 → 「新增凭据」，名称 `test-silent`、类型密码、级别**远程直接用**、值 `test-value-123`
  - 预期：列表出现 `{{secret:test-silent}}` + 两个标签（密码 / 远程直接用）
  - 判失败：列表没出现；或出现后值可被直接看到
- [ ] **A2** 再建两条：`test-confirm`（远程需确认）、`test-local`（仅本机）
- [ ] **A3** 建一条**项目作用域**：`test-proj`，根目录填当前项目路径
- [ ] **A4** 重名（再建一次 `test-silent`）→ 预期提示「名称已存在」
- [ ] **A5** 名称填 `Bad Name` → 预期提示只允许小写/数字/`._-`
- [ ] **A6** 编辑：把 `test-confirm` 改成「仅本机」再改回来 → 预期两次都保存成功、标签跟着变
- [ ] **A7** 删除：点删除 → 出现「取消 / 确认删除」两段式 → 确认后消失
  - 判失败：一点就删（缺二次确认）

### B. 明文显示 / 复制 / 审计

- [ ] **B1** 点「显示」→ 出现明文 + 提示「15 秒后自动隐藏」→ **等 15 秒，应自己收起**
- [ ] **B2** 点「复制」→ 提示已复制；粘贴出来是正确值
- [ ] **B3** 两次操作后看审计：多两条 `reveal`，列表里该凭据「使用 N 次+N」
- [ ] **B4** 复制后检查剪贴板历史（Win+V）——**已知行为：不会自动清空**（见 §5 已知缺口）

### C. 注入（silent 级）

- [ ] **C1** **新建会话**，让 agent 跑 `echo ${MPI_SECRET_TEST_SILENT:+已注入}`
  - 预期：输出「已注入」
  - 判失败：空输出（说明没注入，或用了旧会话）
- [ ] **C2** 让它跑 `echo ${MPI_SECRET_TEST_CONFIRM:-未注入}` 与 `${MPI_SECRET_TEST_LOCAL:-未注入}`
  - 预期：都输出「未注入」
- [ ] **C3** 在**旧会话**里（A 步之前就开着的）跑 C1
  - 预期：未注入 —— 这是**设计如此**（环境变量在会话启动时注入），不是 bug
- [ ] **C4** 让它描述「有哪些凭据可用、哪些不可用及原因」→ 预期能说出 `test-confirm` 需确认、`test-local` 仅本机
- [ ] **C5** 回到项目根之外新建会话（换一个项目）→ `test-proj` 应列为「属于其它项目」

### D. 中介（`mpi_secret_run`）

- [ ] **D1** 桌面新建会话，让它：`用 mpi_secret_run 凭据 test-confirm 执行 echo $MPI_SECRET_VALUE`
  - 预期：弹**审批卡片**（标题含凭据名与命令预览）→ 点「同意执行」→ 返回 `test-value-123` 级别的输出
  - 判失败：没弹卡片直接执行（安全缺口，必须记）
- [ ] **D2** 同样操作但点「拒绝」→ 预期 agent 说未执行，**没有**新的 `exec` 审计
- [ ] **D3** 让它执行 `echo "value=$MPI_SECRET_VALUE"`
  - 预期：回执里出现 `***`，模型拿不到明文
- [ ] **D4** 让它带一个不存在的凭据名 → 预期回执 `NO_CREDENTIAL` 且话术说明
- [ ] **D5** 让它 `sleep 5`（在命令里）→ 预期正常等待并返回；不要出现「超时」误报
- [ ] **D6** 审计里应出现 `exec`（成功）与 `deny`（拒绝/无凭据），**且搜不到明文**

### E. 远程 / 手机

- [ ] **E1** 手机连上主机 → 设置/凭据相关入口**看不到明文**（按设计手机端无查看入口）
- [ ] **E2** 手机发一句让它用 `test-local` 执行命令 → 预期被拒，回复说明「该凭据标记为仅本机」
- [ ] **E3** 手机发一句让它用 `test-confirm` 执行 → 预期**手机上也弹审批卡**（复用 ui.request）→ 同意后执行
  - 判失败：手机上没卡片、命令却在跑
- [ ] **E4** 主机上看审计：E2 应落 `deny / DENIED_LOCAL_ONLY`

### F. 泄漏总检（最重要的一条）

- [ ] **F1** 跑 §0 的万能取证命令 → **必须空输出**
- [ ] **F2** 打开刚才那段对话的会话文件，搜 `test-value-123` → 无命中
- [ ] **F3** `<userData>/logs/mpi-diag.log` 搜 `test-value-123` → 无命中
- [ ] **F4** `credentials.json` 里该记录的值以 `enc:` 开头
- [ ] **F5** `secret-inbox/` 是空的（请求都被消费了）

---

## 4. 常见失败与定位

| 现象 | 先看哪里 | 常见原因 |
|---|---|---|
| 面板提示「凭据库需要重启」 | 是不是只 `Ctrl+R` 了 | 改了主进程/preload，必须 `restart-dev.sh` |
| 新建凭据报「本机加密不可用」 | Electron `safeStorage` 未就绪 | 启动早期调用 / 非 Windows 用户态；**这是 fail-closed 的正确行为** |
| `${MPI_SECRET_X}` 为空 | 是不是旧会话 | 变量在 spawn 时注入，改完要新建会话 |
| 项目级凭据在本项目用不了 | 路径写法 | `scope.root` 与实际 cwd 需一致（大小写/斜杠不敏感，盘符必须一致） |
| `mpi_secret_run` 一直不返回 | `<userData>/secret-inbox/` 有没有请求文件 | 主进程没起摄取循环（重启）；或审计里有 `deny` |
| 卡片不弹，命令却执行了 | 审计里有没有 `exec` | **严重**：说明确认环节被绕过，记 bug |
| 审计里出现明文 | 立刻判失败 | 说明某条路径把值写进了字符串 |

---

## 5. 已知缺口（**不是 bug**，别当失败记）

1. **显示明文不需要验证**：Windows Hello 闸门（P3 前置的 WebAuthn）还没接入，目前只有「遮蔽 + 15 秒自动隐藏」。设计文档 §5 有完整方案，依赖渲染层 origin 改造。
2. **复制不自动清剪贴板**：Windows 剪贴板历史会留存，UI 文案已提示。
3. **每次执行都要点一次卡**：30 分钟免重复授权**没做**（等真实使用反馈再决定）。
4. **`confirm` 级在桌面也要确认**：语义上「本机可直接用」尚未实现简化，当前一致要求确认——安全优先的保守选择。
5. **`models.json` 里 5 个明文 API key 未迁移**：取决于 pi 是否支持 env 兜底（未验证）。
6. **手机端无凭据管理界面**：只能看会话内容；凭据新增/修改只在桌面。

---

## 6. 准出标准

全部满足才算这个模块可交付：

1. `npm run typecheck` + `npm run check:ext` + `npm test -- credentials` + `npm test -- secret-broker` + `npm test -- registry` 全绿
2. §3 的 A–F 全部勾上
3. §0 万能取证命令空输出（**这条一票否决**）
4. 审计里 `inject` / `exec` / `deny` / `reveal` 四类都能各看到至少一条

---

## 7. 后续（不在本次测试范围）

| 项 | 依赖 |
|---|---|
| Windows Hello 闸门（显示明文前验证） | 渲染层 origin 改为 `http://localhost`（大改动，单排一个版本） |
| 30 分钟免重复授权 | 无（纯策略，体验反馈后决定） |
| 手机端设备断言（P3） | PWA 需 https + 域名，或安卓原生 BiometricPrompt |
| `models.json` / `mcp.json` 密钥迁入库 | 先验证 pi 的 env 兜底能力 |
| SSH 密钥 + 自管 `ssh-agent` | 验证 `SSH_AUTH_SOCK` 在 pi 子进程的继承（设计文档 §8） |

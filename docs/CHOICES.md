# choices 内联面板：交互与格式契约

> 适用范围：桌面（`src/renderer`）、PWA（`mobile/pwa`）、安卓（`mobile/app`）。
> 三端共用同一份用户回传格式；改契约时必须三端同步（见末尾清单）。
> 最后更新：2026-10-25。

## 1. 它是什么

模型在回复里输出一个 ```` ```choices ```` 围栏，MPI 把它渲染成可点击的多题选择面板；
用户点选后，MPI 把答案合并成**一条**用户消息（「我的选择：…」）发回给模型。
面板状态**从会话记录推导**，不额外持久化，所以刷新/换设备后仍然正确。

## 2. 模型侧：围栏格式

```choices
[
  {
    "title": "问题（≤200 字）",
    "options": [
      "纯文本选项",
      { "label": "带说明的选项", "detail": "一行细节（可折叠）" }
    ]
  }
]
```

硬性限制（超出会被截断而不是整块拒绝）：

| 项 | 限制 |
|---|---|
| 题数 | 1–6（多于 6 截断，面板下方给一行说明） |
| 每题选项 | 2–6 |
| 标题 | ≤200 字；空标题的题会被丢弃 |
| 选项 | 字符串，或 `{label, detail}`；`label` 必填 |

- 开围栏的 info string 容错：`choices` / `Choices` / `choices>` 都认；`choicesjson` 这类**疑似档**只有在正文严格合法时才升级为面板。
- 闭合反引号可以粘在 JSON 行尾，或干脆漏写——仅当正文能解析成合法 choices 时才接受。
- 系统提示里的对应说明：`src/main/choice-logic.ts` 的 `qaModeInstruction()`（中文/英文各一份，改文案两处都要动）。

## 3. 用户侧：回传格式（契约核心）

```
我的选择：
1. 这批改动怎么收尾？ → 直接 commit，等你确认再推
3. 部署方式？ → 其它：手动拷贝
补充：这组问题还缺一个维度
```

规则：

| 情况 | 回传 |
|---|---|
| 选了某个选项 | `N. 标题 → 选项 label` |
| 选了「其它」 | `N. 标题 → 其它：<自定义文本>` |
| **跳过且没写补充** | **整行不出现**（题目都不给模型） |
| 跳过且写了补充 | `N. → 补充：<文本>`（不带标题） |
| 整组补充说明 | 最后一题之后单独一行 `补充：<文本>` |
| 全部跳过 | 至少留一行 `（全部跳过）`，不发空消息 |
| 一题都不落（构建侧防御） | 未被选中的题按上述规则省略 |

- 整组补充 ≤ 200 字（`CHOICE_NOTE_MAX`），构建与解析两侧都会截断。
- **兼容旧格式**：选项行尾的 `（补充：…）` / `(note: …)`、带标题的 `N. 标题 → 已跳过` 仍能被解析成该题答案，历史会话不受影响。UI 已不再产生每题 note。
- 解析判定（`parseChoiceReply`）：
  - 必须以 `我的选择：` / `My choices:` 开头；
  - 出现过的行必须题号合法、标题匹配（省略标题只允许 `N. → 补充：…`）；
  - **没出现的题 = 跳过**；
  - 任何一行不符合格式 → 返回 null（面板判为 `superseded`，即「用户改用打字回答」）。

## 4. 面板交互

- **选项**：整行可点；有 `detail` 时右侧「细节」按钮展开。
- **其它**：整行虚框，点开行内输入；重新打开会预填上次内容；确认后替代选项。
- **跳过**：题目标题行右侧的幽灵按钮（默认低对比、hover 才浮出，主操作只保留「发送选择」）。点一次变「取消跳过」，两者共用同一个按钮；跳过后该题选项区虚化（opacity 0.45），标题行的「取消跳过」保持可点。
- **整组补充说明**：最后一题之后的整行虚框；点开输入，保存后仍以同款框可见（左侧 `补充：…`），点击可改。冻结后只读显示。
- **发送**：全部题都「已处理」（选过 / 跳过 / 其它）才可发送；漏选时高亮并滚到第一道未答的题。
- **冻结**：该面板所在 assistant 消息之后出现任何 user 消息即冻结——能解析成组合回复 → `answered`（显示 ✓ 与选择）；否则 → `superseded`。
- **草稿**：桌面存 `store.choiceDrafts`（内存），PWA 存 localStorage（7 天过期），安卓存 ViewModel；发送成功后清空。

## 5. 解析与容错

- 围栏解析入口：`splitChoiceSegments`（桌面/PWA 同构）、`withChoiceSegments`（PWA/安卓的流式接入）。
- JSON 修复链（仅在严格解析失败后启用）：转义裸英文双引号 → 补 `{}` 包裹 → 补括号 → 去尾逗号；修复结果必须再通过结构校验。
- 失败降级：整块按普通代码块显示，下方给一行「未渲染成面板」提示，原因分 `syntax`（JSON 非法）与 `shape`（结构不合规）。
- 诊断日志（`src/renderer/src/lib/diag-watch.ts`）：`choice-fence-fail` / `choice-fence-repaired` / `choice-fence-info` / `choice-fence-in-tool`，落 `<userData>/logs/mpi-diag.log`。
- **流式生成时**不逐字渲染围栏 JSON：只保留围栏之前的正文 + 一行「正在生成选项…」，定稿后再解析成面板（桌面 `Chat.tsx`、PWA `ThreadView.tsx`、安卓 `ThreadScreen.kt`）。

## 6. 自动重试（写坏后补救）

扩展 `src/main/mpi-choice-retry-ext.ts`（以 `?raw` 打进主进程，运行时写入 userData 再由 `pi --extension` 加载）：

1. `agent_settled` 后读最后一条 assistant 文本；
2. **保守判定**：出现 choices 标记、但一个合法块都拿不出才重试（已有合法块、纯文本提问一律不重试）；
3. 注入 `display:false` 的修正指令并 `triggerTurn:true` 起一轮，同一条用户消息最多 1 次；
4. 指令只在重试那一轮参与上下文，用完由 `appendContextEdit(id, null)` 摘掉；
5. 设置联动：`qaMode === "manual"`（设置 → 对话设置 → 问答方式）时不重试，按 config.json mtime 缓存实时生效；
6. 总开关：环境变量 `MPI_CHOICE_RETRY=0`。

用户无感要求（改动时别退化）：隐藏消息在主进程 `ipc.ts`、渲染层 `store.ts`、历史列表 `context-estimate.ts` 三处过滤；重试轮不算用户回合（不发完成通知）；被重试那条消息的降级提示自动收起（`choice_retry_start` → `choiceRetryFromKey`）。

## 7. 三端同步清单

改回传格式或交互时，以下文件必须一起看：

| 层 | 桌面 | PWA | 安卓 |
|---|---|---|---|
| 格式/解析 | `src/renderer/src/lib/choice-block.ts` | `mobile/pwa/src/lib/choice-block.ts` | `ui/ChoiceLogic.kt` |
| 面板 UI | `src/renderer/src/components/ChoicePanel.tsx` | `mobile/pwa/src/components/ChoicePanel.tsx` | `ui/ChoicePanel.kt` |
| 样式 | `src/renderer/src/styles.css`（`.cp-*`） | `mobile/pwa/src/styles.css` | Compose 内联 |
| 测试 | `scripts/test-choice-block.mjs` | `scripts/test-pwa-choice.mjs` | `test/.../ChoiceLogicTest.kt` |

另外：模型侧提示在 `src/main/choice-logic.ts`；自动重试在 `src/main/mpi-choice-retry-ext.ts`。

## 8. 测试

```bash
npm run typecheck
npm run test:choice-block      # 围栏解析 + 回传契约（跳过/补充/兼容）
npm run test:choice            # mode-switch 与旧工具结果
npm run test:pwa-choice        # PWA 侧同契约
npm run test:choiceretry       # 自动重试判定、设置联动、指令清理
cd mobile/app && JAVA_HOME=<MyWorkspace>/Software/jdk21 ./gradlew :app:testDebugUnitTest
```

## 9. 已知边界

- 选项 label 若恰好以「（补充：」或「(note:」结尾，解析时会被当成旧格式的补充后缀（实际几乎不会发生）。
- 跳过 + 补充时输出的是**无标题**行 `N. → 补充：…`，模型只能靠题号与上面的围栏对应。
- 安卓没有原生虚线边框，补充说明入口用实线 `OutlinedButton`（与桌面/PWA 的虚框视觉不完全一致）。
- 重试只在「有 choices 标记但没合法块」时触发；模型完全不提 choices 的轮次不会被强行拉回面板。

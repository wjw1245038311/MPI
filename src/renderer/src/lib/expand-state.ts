/**
 * 折叠块（思考过程 / 工具卡）展开状态的跨重挂载存储。
 *
 * open 状态原本存在组件本地 useState——任何祖先级 React 重挂载都会把它重置回
 * 折叠。实测最常见的触发源是 dev HMR：agent 会话中 agent 自己编辑 renderer
 * 源码 → Vite 热更新替换 Chat.tsx 模块 → 整棵聊天树重挂载 → 用户展开的块被
 * 「折叠回去」。把状态提升到本模块的 Map（key = 消息key:块序号，与 BlockView
 * 的 React key 一致）：本模块不随业务改动，HMR 替换 Chat.tsx 时实例存活，
 * 组件重挂载后从 Map 恢复 open。
 *
 * 语义：Map 有值 = 用户明确交互过（展开或收起），重挂载必须尊重；无值 =
 * 尚未交互，走各组件默认逻辑（如 edit 卡自动展开）。显式收起也记录 false——
 * 否则「用户收起了自动展开的 edit 卡」与「未交互」无法区分，重挂载会被
 * autoExpand 重新打开。条目数受会话规模限制（每块至多一条），页面刷新即清空。
 */
const state = new Map<string, boolean>();

export function getExpandState(key: string): boolean | undefined {
  return state.get(key);
}

export function setExpandState(key: string, open: boolean): void {
  state.set(key, open);
}

import { parseChatCommand, resolveThreadTarget } from "../src/main/messaging/command-parse.ts";

const cases = [
  // [input, expected]
  ["新建", "new"], ["/new", "new"], ["NEW", "new"], ["新建会话。", "new"],
  ["开个新对话", "new"], ["帮我新建一个会话", "new"], ["我要开一个新的对话", "new"],
  ["new session", "new"], ["start a new chat", "new"],
  // list
  ["列表", "list"], ["/list", "list"], ["有哪些会话", "list"], ["看看有哪些会话", "list"],
  ["列出最近的会话", "list"], ["显示会话列表", "list"], ["list sessions", "list"],
  ["帮我看看有哪些微信会话", "list"], ["看看微信会话", "list"],
  // use by number
  ["/use 2", "use:2"], ["切到第2个", "use:2"], ["用第二个", "use:2"], ["切换到3", "use:3"],
  ["换回第10个会话", "use:10"], ["switch to 4", "use:4"],
  // use by keyword (must end with noun/demonstrative)
  ["切到飞书那个会话", "use:飞书"], ["换回微信的对话", "use:微信"],
  ["switch to the feishu session", "use:feishu"],
  // back
  ["上一个", "back"], ["回到上一个会话", "back"], ["刚才那个", "back"], ["go back", "back"],
  // NOT commands (real questions must pass through)
  ["帮我写个新建用户的接口", null], ["怎么新建数据库", null], ["切换到开发分支", null],
  ["用2个线程跑一下", null], ["有哪些文件", null], ["上一个问题是什么", null],
  ["帮我看看这个微信会话为什么断了", null],
  ["如何创建一个新表", null], ["a new feature request", null],
  ["帮我看看这个报错是什么原因导致的，日志在 /var/log/app.log 里", null], // long message
];

let fail = 0;
for (const [input, expected] of cases) {
  const r = parseChatCommand(input);
  const got = r ? (r.kind === "use" ? `use:${r.arg}` : r.kind) : null;
  if (got !== expected) { fail++; console.log(`FAIL: ${JSON.stringify(input)} -> ${got} (want ${expected})`); }
}

// resolveThreadTarget
const threads = [
  { id: "a1", title: "飞书接入调试" },
  { id: "b2", title: "微信通道排查" },
  { id: "c3", title: "飞书消息格式" },
];
let r1 = resolveThreadTarget(threads, "a1");
if (!("target" in r1) || r1.target.id !== "a1") { fail++; console.log("FAIL exact id"); }
let r2 = resolveThreadTarget(threads, "微信");
if (!("target" in r2) || r2.target.id !== "b2") { fail++; console.log("FAIL unique keyword:", JSON.stringify(r2)); }
let r3 = resolveThreadTarget(threads, "飞书");
if (!r3 || !("candidates" in r3) || r3.candidates.length !== 2) { fail++; console.log("FAIL ambiguous:", JSON.stringify(r3)); }
let r4 = resolveThreadTarget(threads, "不存在的标题xyz");
if (r4 !== null) { fail++; console.log("FAIL no-match should be null"); }

console.log(fail === 0 ? `ALL ${cases.length + 4} CASES PASSED` : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

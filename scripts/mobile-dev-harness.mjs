/**
 * 手机端联调环境（**开发工具，不是测试**）。
 *
 * 本地起一套真实链路：relay（明文 ws）+ 真 RemoteHost + 真 RelayUplink，
 * 然后用 `autoApprove` 票据打印一条配对链接。
 *
 * 为什么要它：Android 端的界面/协议迭代需要反复配对，而走桌面 GUI 每次都要
 * 手点「生成二维码 → 允许」；这里用 `createPairingTicket({ autoApprove: true })`
 * 把桌面侧的交互省掉。**用到的全是生产代码**（RemoteHost / RelayUplink / relay），
 * 只有 `service.handle` 是喂假数据的桩——真实 RemoteService 绑在桌面应用状态上，
 * 没法脱离 GUI 启动。
 *
 * 用法：
 *   node --experimental-transform-types scripts/mobile-dev-harness.mjs
 *   RELAY_PORT=9001 node --experimental-transform-types scripts/mobile-dev-harness.mjs
 *
 * 模拟器连法（宿主机 9001 → 设备 9001）：
 *   adb reverse tcp:9001 tcp:9001
 * 然后粘贴生成的 pair-link-local.txt 里的链接。
 * 真机（同局域网）：用 pair-link-lan.txt 里的链接。
 *
 * 按回车（或输入 l）= 再发一张票据（票据一次性，重复配对要新的）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register(new URL("./electron-stub-loader.mjs", import.meta.url));

const PORT = Number(process.env.RELAY_PORT || 9001);
const OUT_DIR = join(ROOT, "tempfile", "mobile-harness");
const USER_DATA = join(OUT_DIR, "userdata");

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), "[harness]", ...args);

// ---- 假的主机业务（真实 RemoteService 离了桌面 GUI 起不来）-------------------------

const now = () => Date.now();
let pollTick = 0;

const projectsOf = () => [
  { id: "proj-mpi", name: "MPI", threadCount: 3, updatedAt: now() - 60_000 },
  { id: "proj-demo", name: "Demo 项目", threadCount: 2, updatedAt: now() - 3_600_000 },
];

const threadsOf = (projectId) => {  if (projectId === "proj-mpi") {
    // 每次被问一次就往前走一格：这样能肉眼确认「轮询在跑、列表在刷新」
    pollTick += 1;
    return [
      {
        id: "t-running",
        projectId,
        title: "修复登录 bug",
        preview: "已定位到原因：会话过期时没有清理本地缓存",
        updatedAt: now(),
        messageCount: 12 + pollTick,
        state: "running",
        permission: "sandbox",
      },
      { id: "t-idle", projectId, title: "重构 relay 模块", preview: "拆出 uplink 层", updatedAt: now() - 3_600_000, messageCount: 8, state: "idle", permission: "full" },
      { id: "t-error", projectId, title: "跑一遍全量测试", preview: "2 个用例失败", updatedAt: now() - 7_200_000, messageCount: 31, state: "error", permission: "sandbox" },
    ];
  }
  if (projectId === "proj-demo") {
    return [
      { id: "t-demo-draft", projectId, title: "写个示例", preview: "", updatedAt: now() - 86_400_000, messageCount: 0, state: "draft", permission: "sandbox" },
      { id: "t-demo-old", projectId, title: "连通性验证", preview: "通了", updatedAt: now() - 172_800_000, messageCount: 4, state: "disconnected", permission: "sandbox" },
    ];
  }
  return [];
};

function makeService(responseFor, errorFor) {
  return {
    handle: async (request, ctx) => {
      log(`← ${request.type}${request.threadId ? ` threadId=${request.threadId}` : ""}`);
      switch (request.type) {
        case "projects.list":
          ctx.send(responseFor(request, { projects: projectsOf() }));
          break;
        case "threads.list": {
          const projectId = String(request.payload?.projectId ?? "");
          ctx.send(responseFor(request, { threads: threadsOf(projectId) }));
          break;
        }
        // 会话快照：内容刻意做得“丰富”（思考块 + 代码块 + 工具块 + 长文本），
        // 好把手机端的渲染路径一次看全。
        case "thread.subscribe":
        case "thread.resync":
          ctx.send(responseFor(request, { snapshot: snapshotOf(String(request.payload?.threadId ?? "")) }));
          break;
        default:
          // 未知类型回错误 envelope —— 客户端把 type 写错了会立刻暴露，
          // 而不是永远等到超时（联调期间靠这条更容易定位问题）。
          log(`  ! 未实现的方法：${request.type}`);
          ctx.send(errorFor(request, "NOT_IMPLEMENTED", `harness 未实现 ${request.type}`));
      }
    },
    disconnect: () => log("设备会话结束"),
  };
}

function snapshotOf(threadId) {
  const now = Date.now();
  return {
    id: threadId || "t-running",
    projectId: "proj-mpi",
    title: "修复登录 bug",
    preview: "已定位到原因",
    updatedAt: now,
    messageCount: 4,
    state: "idle",
    permission: "sandbox",
    cwdName: "MPI",
    model: { provider: "anthropic", id: "model-x" },
    availableModels: [
      { provider: "anthropic", id: "model-x", name: "Model X" },
      { provider: "openai", id: "model-y", name: "Model Y", reasoning: true },
    ],
    thinkingLevel: "low",
    taskMode: null,
    availableModes: [
      { id: "iterate", name: "迭代模式", summary: "沙盒 · 低思考" },
      { id: "research", name: "调研模式", summary: "只读", enforce: "readonly" },
    ],
    contextUsage: { tokens: 12400, contextWindow: 200000, percent: 6.2 },
    messages: [
      {
        id: "m1",
        role: "user",
        blocks: [{ type: "text", text: "帮我看下登录失败的问题" }],
      },
      {
        id: "m2",
        role: "assistant",
        blocks: [
          { type: "thinking", text: "先看 auth 模块的会话过期处理，再确认并发下会不会重复清理。" },
          { type: "text", text: "我先看一下相关文件。\n定位到原因：**会话过期时没有清理本地缓存**。" },
          {
            type: "tool",
            name: "read",
            args: '{"path":"src/auth/session.ts"}',
            result: "export function loadSession() {\n  return cache.get('session') ?? null;\n}",
          },
          {
            type: "text",
            text: "修法如下：\n```ts\nexport function loadSession() {\n  const cached = cache.get('session');\n  if (!cached || isExpired(cached)) {\n    cache.delete('session');\n    return null;\n  }\n  return cached;\n}\n```\n这样就\n不会带着旧 token 重试了。",
          },
        ],
      },
      {
        id: "m3",
        role: "user",
        blocks: [{ type: "text", text: "顺手把单测补上" }],
      },
      {
        id: "m4",
        role: "assistant",
        blocks: [
          { type: "tool", name: "edit", args: '{"path":"src/auth/session.test.ts"}', result: "已写入 3 个用例" },
          { type: "text", text: "补了三个用例：未过期、已过期、并发。全部通过。" },
        ],
      },
    ],
    nextSeq: 0,
  };
}

// ---- relay ------------------------------------------------------------------------

async function startRelay() {
  const child = spawn(process.execPath, [join(ROOT, "mobile", "relay", "index.mjs")], {
    env: { ...process.env, RELAY_PORT: String(PORT), RELAY_HOST: "0.0.0.0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let buffer = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay 5s 内没起来")), 5_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/ready ws:\/\/[^:]+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`relay 提前退出（code ${code}）`)));
  });
  return { child, port };
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

// ---- main -------------------------------------------------------------------------

async function main() {
  mkdirSync(USER_DATA, { recursive: true });

  const relay = await startRelay();
  log(`relay 就绪：ws://0.0.0.0:${relay.port}/ws`);

  process.env.MPI_TEST_USER_DATA = USER_DATA;
  const { RemoteHost } = await import("../src/main/remote/host.ts");
  const { RelayUplink } = await import("../src/main/remote/relay-uplink.ts");
  const { responseFor, errorFor } = await import("../mobile/shared/protocol.ts");

  const host = new RemoteHost({
    userDataDir: USER_DATA,
    signalingUrl: "",
    stunUrls: [],
    sendToRenderer: (channel, payload) => {
      if (channel === "remote:pairing-request" || channel === "remote:pairing-auto-approved") {
        log(`桌面事件 ${channel}：device=${payload?.deviceId ?? "?"} name=${payload?.deviceName ?? "?"}`);
      }
    },
    service: makeService(responseFor, errorFor),
  });
  host.start();
  log(`主机身份：${host.getStatus().hostId}`);

  const material = host.getRelayCryptoMaterial();
  const uplink = new RelayUplink({
    relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
    hostId: host.getStatus().hostId,
    userDataDir: USER_DATA,
    x25519PrivB64u: material.x25519PrivB64u,
    x25519PubB64u: material.x25519PubB64u,
    getHost: () => host,
  });
  host.setRelay(uplink);
  uplink.start();

  for (let i = 0; i < 100 && uplink.getStatus().state !== "connected"; i++) await sleep(50);
  log(`uplink 状态：${uplink.getStatus().state}`);
  if (uplink.getStatus().state !== "connected") {
    throw new Error(`uplink 没连上：${uplink.getStatus().lastError ?? "unknown"}`);
  }

  const issueLink = (relayUrl, file) => {
    const ticketInfo = host.createPairingTicket({ autoApprove: true });
    const payload = {
      hostId: ticketInfo.hostId,
      fingerprint: ticketInfo.fingerprint,
      hostPublicKeyPem: ticketInfo.hostPublicKeyPem,
      relayUrl,
      ticket: ticketInfo.ticket,
      expiresAt: ticketInfo.expiresAt,
      protocol: 1,
      hostName: "MPI 联调主机",
    };
    const link = `mpi://pair?payload=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    writeFileSync(join(OUT_DIR, file), link, "utf8");
    return link;
  };

  const localUrl = `ws://127.0.0.1:${relay.port}/ws`;
  const lan = lanAddress();
  const lanUrl = lan ? `ws://${lan}:${relay.port}/ws` : null;

  console.log("");
  console.log("─".repeat(72));
  console.log(`模拟器：先执行  adb reverse tcp:${relay.port} tcp:${relay.port}`);
  console.log(`配对链接已写入  tempfile/mobile-harness/pair-link-local.txt`);
  if (lan) {
    console.log(`真机（同局域网）：用 pair-link-lan.txt（中继 = ${lanUrl}）`);
  }
  console.log("按回车再发一张票据（票据一次性，重复配对用得上）；Ctrl+C 退出。");
  console.log("─".repeat(72));
  console.log("");

  issueLink(localUrl, "pair-link-local.txt");
  if (lanUrl) issueLink(lanUrl, "pair-link-lan.txt");

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", () => {
    const link = issueLink(localUrl, "pair-link-local.txt");
    if (lanUrl) issueLink(lanUrl, "pair-link-lan.txt");
    log("新票据已生成（文件已更新）");
    console.log(link);
  });

  const shutdown = () => {
    log("退出中…");
    try { uplink.stop(); } catch { /* ignore */ }
    try { relay.child.kill(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

main().catch((error) => {
  console.error("[harness] 启动失败：", error);
  process.exit(1);
});

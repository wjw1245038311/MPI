import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const root = mkdtempSync(join(tmpdir(), "mpi-channel-ext-"));
try {
  // --- fake main process: config + registry + ingest loop -------------------
  const fakeUserData = join(root, "userData");
  mkdirSync(fakeUserData, { recursive: true });
  const { loadConfig } = await import("../src/main/config.ts");
  loadConfig(fakeUserData);
  const { ensureChannelCommandInbox, ingestChannelCommands } = await import(
    "../src/main/messaging/channel-command.ts"
  );
  const { registerChannelThread } = await import("../src/main/messaging/channel-threads.ts");

  const THREAD_ID = "abc-123-thread";
  registerChannelThread(THREAD_ID, {
    channel: "wechat",
    notifyApproval: async () => {},
    handleCommand: async (action, target) => {
      if (action === "list") return { ok: true, sessions: [{ index: 1, title: "会话A", current: true }, { index: 2, title: "飞书接入调试", current: false }] };
      if (action === "switch") return { ok: true, switchedTo: `S:${target}` };
      return { ok: true, switchedTo: "(new session)" };
    },
  });

  // Simulate the production watcher with a fast poll.
  const ingestTimer = setInterval(() => ingestChannelCommands(), 50);

  // --- fake pi runtime: load the REAL extension source against stubs ---------
  const extDir = join(root, "ext");
  mkdirSync(join(extDir, "node_modules", "typebox"), { recursive: true });
  writeFileSync(
    join(extDir, "node_modules", "typebox", "package.json"),
    JSON.stringify({ name: "typebox", main: "index.js" }),
  );
  writeFileSync(
    join(extDir, "node_modules", "typebox", "index.js"),
    "exports.Type = { Object: (o) => o, String: () => ({}), Optional: (x) => x };\n",
  );
  const extPath = join(extDir, "ext.ts");
  copyFileSync("src/main/messaging/channel-command-ext.ts", extPath);

  // The extension derives its thread id from the session file name.
  process.env.MPI_CHANNEL_INBOX_DIR = ensureChannelCommandInbox();
  process.env.MPI_CHANNEL_SESSION_FILE = join(root, "sessions", `2026-09-10T00-00-00Z_${THREAD_ID}.jsonl`);

  const tools = {};
  // Windows: dynamic import needs a file:// URL for absolute paths.
  const extMod = await import(pathToFileURL(extPath).href);
  extMod.default({ registerTool: (def) => (tools[def.name] = def) });
  assert.deepEqual(Object.keys(tools).sort(), [
    "mpi_channel_list_sessions",
    "mpi_channel_new_session",
    "mpi_channel_switch_session",
  ]);

  const textOf = (r) => r.content.find((b) => b.type === "text").text;

  // list → real sessions come back through the inbox round-trip
  let out = await tools.mpi_channel_list_sessions.execute();
  assert.ok(textOf(out).includes("1. ➜ 会话A"), textOf(out));
  assert.ok(textOf(out).includes("2. 飞书接入调试"), textOf(out));

  // switch by number → handler result surfaces to the agent
  out = await tools.mpi_channel_switch_session.execute("t1", { target: "2" });
  assert.equal(textOf(out), "Switched to session: S:2. The user's next message will go there.");

  // new → confirmation text
  out = await tools.mpi_channel_new_session.execute();
  assert.ok(textOf(out).startsWith("Created a fresh session."), textOf(out));

  // switch with empty target → client-side validation error (no round-trip)
  out = await tools.mpi_channel_switch_session.execute("t2", { target: "   " });
  assert.ok(textOf(out).startsWith("Error:"), textOf(out));

  clearInterval(ingestTimer);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("channel-ext e2e tests passed");

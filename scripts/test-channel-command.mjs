import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

// Point the config (and therefore the channel inbox) at a temp userData dir.
const fakeUserData = mkdtempSync(join(tmpdir(), "mpi-channel-test-"));
const { loadConfig } = await import("../src/main/config.ts");
loadConfig(fakeUserData);

const { channelCommandInboxDir, ensureChannelCommandInbox, ingestChannelCommands } = await import(
  "../src/main/messaging/channel-command.ts"
);
const {
  registerChannelThread,
  unregisterChannelThread,
  threadUuidFromSessionFile,
  isChannelOwnedSession,
} = await import("../src/main/messaging/channel-threads.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Ingest once and give the async handlers a moment to finish. */
async function ingestSettled() {
  ingestChannelCommands();
  await sleep(150);
}

// --- routing to a registered channel thread ---------------------------------
registerChannelThread("sess-1", {
  channel: "wechat",
  notifyApproval: async () => {},
  handleCommand: async (action, target) => {
    if (action === "list")
      return { ok: true, sessions: [{ index: 1, title: "A", current: true }, { index: 2, title: "B", current: false }] };
    if (action === "switch") return { ok: true, switchedTo: `S:${target}` };
    return { ok: true, switchedTo: "(new session)" };
  },
});

const inbox = ensureChannelCommandInbox();
assert.equal(inbox, channelCommandInboxDir());

// list request → response with sessions, request consumed
writeFileSync(join(inbox, "req-list.json"), JSON.stringify({ sessionId: "sess-1", action: "list" }));
await ingestSettled();
const resp = JSON.parse(readFileSync(join(inbox, "req-list.resp.json"), "utf8"));
assert.equal(resp.ok, true);
assert.deepEqual(resp.sessions[0], { index: 1, title: "A", current: true });
assert.equal(readdirSync(inbox).includes("req-list.json"), false); // request deleted

// switch with target → handler receives it
writeFileSync(join(inbox, "req-switch.json"), JSON.stringify({ sessionId: "sess-1", action: "switch", target: "2" }));
await ingestSettled();
assert.equal(JSON.parse(readFileSync(join(inbox, "req-switch.resp.json"), "utf8")).switchedTo, "S:2");

// unknown session → not_channel_session
writeFileSync(join(inbox, "req-unknown.json"), JSON.stringify({ sessionId: "nope", action: "list" }));
await ingestSettled();
assert.equal(JSON.parse(readFileSync(join(inbox, "req-unknown.resp.json"), "utf8")).error, "not_channel_session");

// registered but no handleCommand → not_channel_session
registerChannelThread("sess-2", { channel: "feishu", notifyApproval: async () => {} });
writeFileSync(join(inbox, "req-nohandler.json"), JSON.stringify({ sessionId: "sess-2", action: "new" }));
await ingestSettled();
assert.equal(JSON.parse(readFileSync(join(inbox, "req-nohandler.resp.json"), "utf8")).error, "not_channel_session");

// corrupt file → left in place for inspection, no response
writeFileSync(join(inbox, "req-corrupt.json"), "{not json");
await ingestSettled();
assert.equal(readdirSync(inbox).includes("req-corrupt.json"), true);
assert.equal(readdirSync(inbox).some((n) => n === "req-corrupt.resp.json"), false);

// invalid action → ignored (no response), file left for inspection
writeFileSync(join(inbox, "req-badaction.json"), JSON.stringify({ sessionId: "sess-1", action: "frobnicate" }));
await ingestSettled();
assert.equal(readdirSync(inbox).some((n) => n === "req-badaction.resp.json"), false);

// stale .resp.json pruning (> 1h old — orphaned by a timed-out extension)
writeFileSync(join(inbox, "stale.resp.json"), "{}");
const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
utimesSync(join(inbox, "stale.resp.json"), past, past);
await ingestSettled();
assert.equal(readdirSync(inbox).includes("stale.resp.json"), false);

// handler throwing → error surfaced in the response (not a crash)
registerChannelThread("sess-3", {
  channel: "feishu",
  notifyApproval: async () => {},
  handleCommand: async () => {
    throw new Error("boom");
  },
});
writeFileSync(join(inbox, "req-throw.json"), JSON.stringify({ sessionId: "sess-3", action: "list" }));
await ingestSettled();
assert.equal(JSON.parse(readFileSync(join(inbox, "req-throw.resp.json"), "utf8")).error, "boom");

// --- session-file UUID helpers (registry key + spawn-time gating) -----------
const uuid = "01a07ec2-06ea-714b-af5b-ed45d12178d2";
assert.equal(
  threadUuidFromSessionFile(`/x/sessions/--proj--/2026-09-08T02-04-00-106Z_${uuid}.jsonl`),
  uuid,
);
// Windows-style paths use backslashes — basename handles both separators
assert.equal(
  threadUuidFromSessionFile(`C:\\pi\\sessions\\dir\\2026-09-08T02-04-00-106Z_${uuid}.jsonl`),
  uuid,
);
assert.equal(threadUuidFromSessionFile("/x/foo.jsonl"), null); // no "_<id>" part
assert.equal(threadUuidFromSessionFile("/x/foo.txt"), null); // not a session file

assert.equal(isChannelOwnedSession(undefined), false);
assert.equal(isChannelOwnedSession(`/x/sessions/--proj--/2026-09-08T02-04-00-106Z_${uuid}.jsonl`), false); // not registered yet
registerChannelThread(uuid, { channel: "feishu", notifyApproval: async () => {} });
assert.equal(isChannelOwnedSession(`/x/sessions/--proj--/2026-09-08T02-04-00-106Z_${uuid}.jsonl`), true);
unregisterChannelThread(uuid);
assert.equal(isChannelOwnedSession(`/x/sessions/--proj--/2026-09-08T02-04-00-106Z_${uuid}.jsonl`), false);

unregisterChannelThread("sess-1");
unregisterChannelThread("sess-2");
unregisterChannelThread("sess-3");
rmSync(fakeUserData, { recursive: true, force: true });
console.log("channel-command tests passed");

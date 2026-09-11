import assert from "node:assert/strict";
// service.ts is intentionally NOT imported here: its parameter properties are
// unsupported by node's strip-only TS mode. All pure logic lives in feishu-text.
import { parseTextContent, sanitizeFeishuConfig, stripMentions } from "../src/main/messaging/feishu-text.ts";
import { truncateForChat } from "../src/main/messaging/channel-text.ts";

// --- parseTextContent ---------------------------------------------------------
assert.equal(parseTextContent('{"text":"hello"}'), "hello");
assert.equal(parseTextContent('{"text":"@_user_1 你好 world"}'), "@_user_1 你好 world");
assert.equal(parseTextContent('{"text":""}'), "");
assert.equal(parseTextContent("not json"), ""); // unparseable -> empty, not a throw
assert.equal(parseTextContent('{"other":1}'), ""); // no text field
assert.equal(parseTextContent(null), "");
assert.equal(parseTextContent(42), "");

// --- stripMentions ------------------------------------------------------------
assert.equal(stripMentions("@_user_1 hello", [{ key: "@_user_1" }]), "hello");
assert.equal(stripMentions("hi @_user_1 and @_user_2 there", [{ key: "@_user_1" }, { key: "@_user_2" }]), "hi and there");
// leftover tokens not covered by the mentions list are stripped too
assert.equal(stripMentions("@_user_9 ping"), "ping");
// whitespace is collapsed, result trimmed
assert.equal(stripMentions("  a   @_user_1  b ", [{ key: "@_user_1" }]), "a b");
assert.equal(stripMentions("plain text", undefined), "plain text");
assert.equal(stripMentions("@_user_1", [{ key: "@_user_1" }]), ""); // mention-only message -> empty

// --- truncateForChat ----------------------------------------------------------
assert.equal(truncateForChat("short", 100), "short");
assert.equal(truncateForChat("x".repeat(100), 100), "x".repeat(100)); // exact fit, no note
const cut = truncateForChat("y".repeat(200), 50, "truncated");
assert.ok(cut.length <= 50 + "\n…truncated".length);
assert.ok(cut.endsWith("\n…truncated"));
assert.equal(truncateForChat("z".repeat(200), 50).endsWith("\n…"), true); // no note -> bare ellipsis

// --- sanitizeFeishuConfig (IPC boundary) ---------------------------------------
const clean = sanitizeFeishuConfig({
  enabled: "yes", // not a boolean -> false
  appId: "  cli_abc123  ",
  appSecret: "s".repeat(600),
  projectCwd: "/tmp/proj",
  permission: "full",
});
assert.equal(clean.enabled, false);
assert.equal(clean.appId, "cli_abc123"); // trimmed
assert.equal(clean.appSecret.length, 512); // capped
assert.equal(clean.projectCwd, "/tmp/proj");
assert.equal(clean.permission, "full");

const defaults = sanitizeFeishuConfig(undefined);
assert.deepEqual(defaults, { enabled: false, appId: "", appSecret: "", projectCwd: "", permission: "sandbox" });

// hostile shapes cannot inject objects/arrays
const hostile = sanitizeFeishuConfig({ appId: { nested: true }, appSecret: ["x"], permission: "readonly", enabled: 1 });
assert.equal(hostile.appId, "");
assert.equal(hostile.appSecret, "");
assert.equal(hostile.permission, "sandbox"); // only sandbox|full survive

console.log("messaging tests passed");

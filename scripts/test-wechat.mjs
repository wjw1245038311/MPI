import assert from "node:assert/strict";
// wechat-service.ts is intentionally NOT imported here (same strip-types
// constraint as service.ts). Pure logic lives in wechat-text + ilink.
import { extractInboundText, isWeChatConfigured, sanitizeWeChatConfig } from "../src/main/messaging/wechat-text.ts";
import { parseWeixinApiJson } from "../src/main/weixin/ilink.ts";

// --- sanitizeWeChatConfig (IPC / persistence boundary) ------------------------
const clean = sanitizeWeChatConfig({
  enabled: "yes", // not a boolean -> false
  botToken: "  tok_abc  ",
  botId: "bot123",
  baseUrl: "https://ilinkai.weixin.qq.com/",
  userId: "user456",
  projectCwd: "/tmp/proj",
  permission: "full",
});
assert.equal(clean.enabled, false);
assert.equal(clean.botToken, "tok_abc");
assert.equal(clean.baseUrl, "https://ilinkai.weixin.qq.com/"); // https URL kept as-is
assert.equal(clean.permission, "full");

const defaults = sanitizeWeChatConfig(undefined);
assert.equal(defaults.enabled, false);
assert.equal(defaults.botToken, "");
assert.equal(defaults.baseUrl, "https://ilinkai.weixin.qq.com"); // fallback base url
assert.equal(defaults.permission, "sandbox");
assert.ok(!("activeThreadId" in defaults)); // absent key stays absent
assert.ok(!("getUpdatesBuf" in defaults));

const badUrl = sanitizeWeChatConfig({ baseUrl: "http://insecure.example", botToken: "t" });
assert.equal(badUrl.baseUrl, "https://ilinkai.weixin.qq.com"); // non-https rejected -> fallback

// --- isWeChatConfigured ---------------------------------------------------------
assert.equal(isWeChatConfigured(defaults), false);
assert.equal(isWeChatConfigured({ ...defaults, botToken: "tok" }), true);

// --- extractInboundText ----------------------------------------------------------
const textMsg = { message_id: "1", item_list: [{ type: 1, text_item: { text: "hello" } }] };
assert.deepEqual(extractInboundText(textMsg), { text: "hello", hasMedia: false });

const multiText = {
  item_list: [
    { type: 1, text_item: { text: "line one" } },
    { type: 2, image_item: {} },
    { type: 1, text_item: { text: "line two" } },
  ],
};
assert.deepEqual(extractInboundText(multiText), { text: "line one\nline two", hasMedia: true });

const mediaOnly = { item_list: [{ type: 4, file_item: { file_name: "a.txt" } }] };
assert.deepEqual(extractInboundText(mediaOnly), { text: "", hasMedia: true });

assert.deepEqual(extractInboundText({}), { text: "", hasMedia: false }); // no items at all
assert.deepEqual(extractInboundText(null), { text: "", hasMedia: false }); // null-safe

// --- parseWeixinApiJson (lossless uint64 ids) ------------------------------------
const big = "9007199254740993"; // > Number.MAX_SAFE_INTEGER — build the wire text by hand
const raw = `{"ret":0,"message_id":${big},"msgs":[{"msg_id":${big},"svr_id":${big}}]}`;
const parsed = parseWeixinApiJson(raw);
assert.equal(parsed.message_id, big); // quoted to string before JSON.parse → no precision loss
assert.equal(parsed.msgs[0].msg_id, big);
assert.equal(parsed.msgs[0].svr_id, big);
assert.equal(parsed.ret, 0);
// sanity: a plain JSON.parse would have corrupted the id
const naive = JSON.parse(raw);
assert.notEqual(String(naive.message_id), big);

// ids inside JSON strings must NOT be rewritten
const tricky = parseWeixinApiJson('{"message_id":"123","note":"the message_id is 999"}');
assert.equal(tricky.message_id, "123");
assert.equal(tricky.note, "the message_id is 999");

// small numeric ids are also quoted (uniform behavior)
const small = parseWeixinApiJson('{"message_id":42}');
assert.equal(small.message_id, "42");

console.log("wechat: all assertions passed");

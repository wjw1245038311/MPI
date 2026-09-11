import assert from "node:assert/strict";
import { findMessageOccurrences, messageSearchText } from "../src/renderer/src/lib/chat-search.ts";

const user = (key, text) => ({ key, role: "user", text });
const assistant = (key, blocks) => ({ key, role: "assistant", blocks });
const textBlock = (text) => ({ type: "text", text });
const thinkBlock = (thinking) => ({ type: "thinking", thinking });
const toolBlock = (id, name) => ({ type: "toolCall", id, name, arguments: {} });

// --- messageSearchText ---------------------------------------------------------
assert.equal(messageSearchText(user("u1", "hello world")), "hello world");
assert.equal(messageSearchText(assistant("a1", [textBlock("part one"), thinkBlock("secret"), textBlock("part two")])), "part one\npart two");
// thinking + tool payloads are excluded from the corpus
assert.equal(messageSearchText(assistant("a2", [thinkBlock("hidden reasoning"), toolBlock("t1", "bash")])), "");
assert.equal(messageSearchText({ key: "s1", role: "system", text: "note" }), "note");
assert.equal(messageSearchText({ key: "c1", role: "custom", text: "out" }), "out");
assert.equal(messageSearchText(assistant("a3", [])), "");
assert.equal(messageSearchText(user("u2")), ""); // no text

// --- empty / whitespace queries -------------------------------------------------
assert.deepEqual(findMessageOccurrences([user("u1", "abc")], ""), []);
assert.deepEqual(findMessageOccurrences([user("u1", "abc")], "   "), []);

// --- basic case-insensitive substring matching ----------------------------------
const msgs = [
  user("u1", "Fix the login bug"),
  assistant("a1", [textBlock("I will fix the LOGIN flow now.")]),
  user("u2", "thanks"),
];
assert.deepEqual(findMessageOccurrences(msgs, "login"), [{ messageKey: "u1" }, { messageKey: "a1" }]);
assert.deepEqual(findMessageOccurrences(msgs, "LOGIN"), [{ messageKey: "u1" }, { messageKey: "a1" }]);
assert.deepEqual(findMessageOccurrences(msgs, "nope"), []);

// --- multiple occurrences in one message are separate entries --------------------
const multi = [user("u1", "cat cat and CAT")];
assert.deepEqual(findMessageOccurrences(multi, "cat"), [{ messageKey: "u1" }, { messageKey: "u1" }, { messageKey: "u1" }]);

// --- transcript order is preserved -----------------------------------------------
const ordered = [
  user("u1", "alpha"),
  assistant("a1", [textBlock("beta")]),
  user("u2", "gamma alpha"),
];
assert.deepEqual(findMessageOccurrences(ordered, "alpha").map((o) => o.messageKey), ["u1", "u2"]);

// --- query spanning block boundaries does NOT match (blocks joined with \n) ------
const split = [assistant("a1", [textBlock("foo"), textBlock("bar")])];
assert.deepEqual(findMessageOccurrences(split, "foobar"), []); // no accidental join across blocks
assert.deepEqual(findMessageOccurrences(split, "o\nb"), [{ messageKey: "a1" }]); // \n is real content

// --- CJK + mixed scripts ----------------------------------------------------------
const cjk = [user("u1", "请把图标换成雨伞")];
assert.deepEqual(findMessageOccurrences(cjk, "雨伞"), [{ messageKey: "u1" }]);
assert.deepEqual(findMessageOccurrences(cjk, "把图标换"), [{ messageKey: "u1" }]);

// --- whitespace around the query is trimmed ---------------------------------------
assert.deepEqual(findMessageOccurrences([user("u1", "hello")], "  hello  "), [{ messageKey: "u1" }]);

console.log("chat-search tests passed");

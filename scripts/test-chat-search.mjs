import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { findMessageOccurrences, messageSearchUnits } = await import("../src/renderer/src/lib/chat-search.ts");

const user = (key, text) => ({ key, role: "user", text });
const assistant = (key, blocks) => ({ key, role: "assistant", blocks });
const textBlock = (text) => ({ type: "text", text });
const thinkBlock = (thinking) => ({ type: "thinking", thinking });
const toolBlock = (id, name) => ({ type: "toolCall", id, name, arguments: {} });

// --- messageSearchUnits mirrors the rendered prose ------------------------------
assert.deepEqual(messageSearchUnits(user("u1", "hello world")), [{ key: "u1", text: "hello world" }]);
// one unit per text block; keys match renderAssistantBlocks' `${key}:${index}`
assert.deepEqual(
  messageSearchUnits(assistant("a1", [textBlock("part one"), thinkBlock("secret"), textBlock("part two")])),
  [
    { key: "a1:0", text: "part one" },
    { key: "a1:2", text: "part two" },
  ],
);
// thinking + tool payloads are excluded from the corpus
assert.deepEqual(messageSearchUnits(assistant("a2", [thinkBlock("hidden reasoning"), toolBlock("t1", "bash")])), []);
assert.deepEqual(messageSearchUnits({ key: "s1", role: "system", text: "note" }), [{ key: "s1", text: "note" }]);
assert.deepEqual(messageSearchUnits({ key: "c1", role: "custom", text: "out" }), [{ key: "c1", text: "out" }]);
assert.deepEqual(messageSearchUnits(assistant("a3", [])), []);
assert.deepEqual(messageSearchUnits(user("u2")), []); // no text

// /skill:name messages render only the trailing user message — skill content is not searchable
const skillText = '<skill name="remember" location="/x/SKILL.md">\ncontent body\n</skill>\n\nplease do it';
assert.deepEqual(messageSearchUnits(user("u3", skillText)), [{ key: "u3", text: "please do it" }]);

// HTML reference blocks render as cards, not prose — only the visible part is searchable
const htmlRefText = 'look at this button\n[Selected HTML element]\n- selector: `#btn`\n- tag: <button>\n- text: "Click me"';
assert.deepEqual(messageSearchUnits(user("u4", htmlRefText)), [{ key: "u4", text: "look at this button" }]);

// --- empty / whitespace queries -------------------------------------------------
assert.deepEqual(findMessageOccurrences([user("u1", "abc")], ""), []);
assert.deepEqual(findMessageOccurrences([user("u1", "abc")], "   "), []);

// --- basic case-insensitive substring matching ----------------------------------
const msgs = [
  user("u1", "Fix the login bug"),
  assistant("a1", [textBlock("I will fix the LOGIN flow now.")]),
  user("u2", "thanks"),
];
assert.deepEqual(findMessageOccurrences(msgs, "login"), [
  { messageKey: "u1", unitKey: "u1" },
  { messageKey: "a1", unitKey: "a1:0" },
]);
assert.deepEqual(findMessageOccurrences(msgs, "LOGIN"), [
  { messageKey: "u1", unitKey: "u1" },
  { messageKey: "a1", unitKey: "a1:0" },
]);
assert.deepEqual(findMessageOccurrences(msgs, "nope"), []);

// --- multiple occurrences in one unit are separate entries ----------------------
const multi = [user("u1", "cat cat and CAT")];
assert.deepEqual(findMessageOccurrences(multi, "cat"), [
  { messageKey: "u1", unitKey: "u1" },
  { messageKey: "u1", unitKey: "u1" },
  { messageKey: "u1", unitKey: "u1" },
]);

// --- transcript order is preserved -----------------------------------------------
const ordered = [
  user("u1", "alpha"),
  assistant("a1", [textBlock("beta")]),
  user("u2", "gamma alpha"),
];
assert.deepEqual(findMessageOccurrences(ordered, "alpha").map((o) => o.messageKey), ["u1", "u2"]);

// --- blocks are independent units: no accidental join across block boundaries ----
const split = [assistant("a1", [textBlock("foo"), textBlock("bar")])];
assert.deepEqual(findMessageOccurrences(split, "foobar"), []); // not rendered as one string
assert.deepEqual(findMessageOccurrences(split, "o\nb"), []); // the \n between blocks is not rendered content
assert.deepEqual(findMessageOccurrences(split, "oo"), [{ messageKey: "a1", unitKey: "a1:0" }]);

// --- hidden content (skill body / reference cards) never matches ------------------
const hidden = [user("u3", skillText), user("u4", htmlRefText)];
assert.deepEqual(findMessageOccurrences(hidden, "content body"), []);
assert.deepEqual(findMessageOccurrences(hidden, "Click me"), []);
assert.deepEqual(findMessageOccurrences(hidden, "do it"), [{ messageKey: "u3", unitKey: "u3" }]);

// --- CJK + mixed scripts ----------------------------------------------------------
const cjk = [user("u1", "请把图标换成雨伞")];
assert.deepEqual(findMessageOccurrences(cjk, "雨伞"), [{ messageKey: "u1", unitKey: "u1" }]);
assert.deepEqual(findMessageOccurrences(cjk, "把图标换"), [{ messageKey: "u1", unitKey: "u1" }]);

// --- whitespace around the query is trimmed ---------------------------------------
assert.deepEqual(findMessageOccurrences([user("u1", "hello")], "  hello  "), [{ messageKey: "u1", unitKey: "u1" }]);

console.log("chat-search tests passed");

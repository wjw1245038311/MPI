/**
 * 全局快捷键注册表（src/renderer/src/lib/shortcuts.ts）的组合键匹配与输入框守卫。
 *
 * 只测纯函数部分（matchShortcut / isTypingTargetElement）：installShortcuts 需要
 * window，属 L2（Playwright）范畴。
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { matchShortcut, isTypingTargetElement } = await import("../src/renderer/src/lib/shortcuts.ts");

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  ✓ ${m}`);
};

// 基本命中 / 不命中
assert.equal(matchShortcut("Ctrl+N", { ctrlKey: true, key: "n" }), true, "Ctrl+N 命中");
assert.equal(matchShortcut("Ctrl+N", { ctrlKey: true, key: "N" }), true, "大小写不敏感");
assert.equal(matchShortcut("Ctrl+N", { key: "n" }), false, "没按 Ctrl 不算命中");
assert.equal(matchShortcut("Ctrl+N", { ctrlKey: true, shiftKey: true, key: "n" }), false, "多按 Shift 不算命中");
ok("组合键严格匹配（修饰键必须完全一致）");

// 无修饰键的裸键
assert.equal(matchShortcut("Escape", { key: "Escape" }), true, "Esc 命中");
assert.equal(matchShortcut("Escape", { ctrlKey: true, key: "Escape" }), false, "带修饰键时不吞 Esc");
ok("裸键（Escape）只在没有修饰键时命中");

// 同键位写法互认：Shift+= 就是 "+"，Shift+- 就是 "_"
assert.equal(matchShortcut("Ctrl+=", { ctrlKey: true, shiftKey: true, key: "+" }), true, '"+" 命中 Ctrl+=');
assert.equal(matchShortcut("Ctrl+-", { ctrlKey: true, shiftKey: true, key: "_" }), true, '"_" 命中 Ctrl+-');
assert.equal(matchShortcut("Ctrl+0", { ctrlKey: true, key: "0" }), true, "Ctrl+0 命中");
ok("缩放类组合键的 +/− 变体都能命中");

// 多级修饰
assert.equal(matchShortcut("Ctrl+Shift+P", { ctrlKey: true, key: "p" }), false, "少按 Shift 不算命中");
assert.equal(matchShortcut("Ctrl+Shift+P", { ctrlKey: true, shiftKey: true, key: "p" }), true, "Ctrl+Shift+P 命中");
ok("Ctrl+Shift+P 这类三段组合可用（给命令面板预留）");

// 输入框守卫
assert.equal(isTypingTargetElement({ tagName: "TEXTAREA" }), true, "textarea 内不抢键");
assert.equal(isTypingTargetElement({ tagName: "INPUT" }), true, "input 内不抢键");
assert.equal(isTypingTargetElement({ tagName: "DIV", isContentEditable: true }), true, "contenteditable 内不抢键");
assert.equal(isTypingTargetElement({ tagName: "BUTTON" }), false, "按钮上正常触发");
assert.equal(isTypingTargetElement(null), false, "空目标不误判");
ok("焦点在输入区时默认让位（避免打断打字与中文输入法）");

console.log(`\nshortcuts 测试通过：${n} 项`);

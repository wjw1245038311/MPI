/**
 * 全局快捷键注册表。
 *
 * 以前只有 App.tsx 里硬写的两处（Ctrl+K 搜索、Ctrl+=/-/0 缩放）：加一个键要改根组件，
 * 也没有「焦点在输入框时别抢键」的统一判断。这里集中成声明式列表：
 *
 *   installShortcuts([
 *     { id: "search", combo: "Ctrl+K", run: () => … },
 *     { id: "abort",  combo: "Escape", when: () => 正在生成, run: () => … },
 *   ])
 *
 * 约定：
 *   - `Ctrl` 在 Windows/Linux 匹配 Ctrl，在 macOS 匹配 ⌘（与现有行为一致）；
 *   - 默认**不**在输入框 / 文本域 / contenteditable 内触发（避免打断中文输入与
 *     正常打字）；确实需要全局抢键的（如缩放）显式写 `allowInInput: true`；
 *   - `when()` 返回 false 视为未命中，继续交给页面其它处理器。
 */

export interface Shortcut {
  /** 唯一 id，便于排查与后续做「快捷键」设置页。 */
  id: string;
  /** 形如 "Ctrl+N"、"Ctrl+Shift+P"、"Escape"。key 用 e.key 的小写形式。 */
  combo: string;
  /** 焦点在可输入元素里时是否仍然触发（默认 false）。 */
  allowInInput?: boolean;
  /** 额外条件；抛错按「不满足」处理。 */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

const IS_MAC = (() => {
  // 延迟求值 + 容错：纯 Node（L1 测试）里没有 navigator。
  try {
    return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
  } catch {
    return false;
  }
})();

interface Parsed {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseCombo(combo: string): Parsed {
  const parts = combo.split("+");
  const key = (parts.pop() || "").toLowerCase();
  return {
    ctrl: parts.some((p) => /^ctrl$/i.test(p)),
    shift: parts.some((p) => /^shift$/i.test(p)),
    alt: parts.some((p) => /^alt$/i.test(p)),
    key,
  };
}

/** 归一化按键名：让 "=" 与 "+"、"-" 与 "_" 这类同键位写法都能命中。 */
function normalizeKey(raw: string): string {
  const k = raw.toLowerCase();
  if (k === "+" || k === "=") return "=";
  if (k === "_" || k === "-") return "-";
  return k;
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

function matches(e: KeyboardEvent, p: Parsed): boolean {
  // 修饰键一律先转布尔：单测传的是普通对象（缺字段是 undefined，不是 false）。
  const mod = IS_MAC ? !!e.metaKey : !!e.ctrlKey;
  if (p.ctrl !== mod) return false;
  // 「=」「-」这两个键位按 Shift 才能打出「+」「_」：缩放快捷键应当两种都认，
  // 所以组合键没要求 Shift 时，对它们不检查 Shift。
  const shiftAgnostic = !p.shift && (p.key === "=" || p.key === "-");
  if (!shiftAgnostic && p.shift !== !!e.shiftKey) return false;
  if (p.alt !== !!e.altKey) return false;
  return normalizeKey(e.key) === p.key;
}

/**
 * 一个按键事件是否命中某个组合键描述。导出来给单测与「快捷键设置页」复用。
 *
 * `Ctrl` 在 macOS 上匹配 ⌘；`"="` 与 `"+"`、`"-"` 与 `"_"` 同键位互认。
 */
export function matchShortcut(combo: string, e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; key: string }): boolean {
  return matches(e as KeyboardEvent, parseCombo(combo));
}

/** 焦点是否落在可输入元素上（快捷键默认不抢这些地方的键）。 */
export function isTypingTargetElement(t: EventTarget | null): boolean {
  return isTypingTarget(t);
}

/**
 * 安装一批快捷键，返回卸载函数（给 useEffect 的 cleanup 用）。
 *
 * 命中即 `preventDefault()` + `stopPropagation()`：这些组合键都是应用自己占用的，
 * 不该再冒泡给面板里的局部监听。
 */
export function installShortcuts(list: Shortcut[]): () => void {
  const parsed = list.map((s) => ({ s, p: parseCombo(s.combo) }));
  const onKey = (e: KeyboardEvent) => {
    for (const { s, p } of parsed) {
      if (!matches(e, p)) continue;
      if (!s.allowInInput && isTypingTarget(e.target)) continue;
      let allowed = true;
      try {
        allowed = !s.when || s.when();
      } catch {
        allowed = false;
      }
      if (!allowed) continue;
      e.preventDefault();
      e.stopPropagation();
      void Promise.resolve(s.run()).catch(() => {
        /* 动作内部的提示由调用方负责（多数走 pushToast） */
      });
      return;
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

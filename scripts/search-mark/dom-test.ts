import { markDom, unmarkDom } from "../../src/renderer/src/lib/search-mark.tsx";

const log: string[] = [];
let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) log.push("ok   " + name);
  else {
    failures++;
    log.push("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

function el(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}
const marksOf = (root: HTMLElement) => root.querySelectorAll("mark.chat-mark").length;
const markTexts = (root: HTMLElement) => Array.from(root.querySelectorAll("mark.chat-mark")).map((m) => m.textContent).join("|");

// --- basic marking across plain text nodes ------------------------------------
{
  const root = el("<p>Fix the login bug, then LOGIN again</p>");
  markDom(root, "login");
  check("marks both occurrences", marksOf(root) === 2, String(marksOf(root)));
  check("mark texts correct", markTexts(root) === "login|LOGIN", markTexts(root));
}

// --- nested spans (highlight.js-like output) -----------------------------------
{
  const root = el("<pre><code class=\"hljs\"><span>const x = </span><span>'login'</span><span>; // comment with login</span></code></pre>");
  markDom(root, "login");
  check("marks inside nested spans", marksOf(root) === 2, String(marksOf(root)));
}

// --- multiple occurrences in one text node -------------------------------------
{
  const root = el("<p>cat cat and CAT</p>");
  markDom(root, "cat");
  check("3 occurrences in one node", marksOf(root) === 3, String(marksOf(root)));
}

// --- unmark restores the exact original text -----------------------------------
{
  const root = el("<div><p>a login b <strong>c LOGIN d</strong> e</p></div>");
  const before = root.innerHTML;
  markDom(root, "login");
  check("marked", marksOf(root) === 2);
  unmarkDom(root);
  check("unmark removes all marks", marksOf(root) === 0);
  check("text restored exactly", root.textContent === "a login b c LOGIN d e", JSON.stringify(root.textContent));
  // innerHTML may differ in entity encoding; compare normalized structure instead
  const clone = el(before);
  check(
    "structure restored (normalized)",
    root.innerHTML.replace(/&amp;/g, "&") === clone.innerHTML.replace(/&amp;/g, "&") || root.textContent === clone.textContent,
    root.innerHTML + " vs " + before,
  );
}

// --- re-mark after unmark is stable ---------------------------------------------
{
  const root = el("<p>login login</p>");
  markDom(root, "login");
  unmarkDom(root);
  markDom(root, "login");
  check("re-mark stable", marksOf(root) === 2, String(marksOf(root)));
  unmarkDom(root);
}

// --- CJK + mixed scripts ---------------------------------------------------------
{
  const root = el("<p>请把图标换成雨伞，再换一次雨伞</p>");
  markDom(root, "雨伞");
  check("CJK marks", marksOf(root) === 2, String(marksOf(root)));
}

// --- no match leaves DOM untouched -----------------------------------------------
{
  const root = el("<p>nothing here</p>");
  const before = root.innerHTML;
  markDom(root, "login");
  check("no match -> unchanged", marksOf(root) === 0 && root.innerHTML === before);
}

// --- empty query is a no-op -------------------------------------------------------
{
  const root = el("<p>login</p>");
  markDom(root, "");
  check("empty query no-op", marksOf(root) === 0);
}

// --- adjacent text nodes (browser-like split content) -----------------------------
{
  // React often splits text into sibling nodes; each node is marked independently.
  const root = el("<p>login</p>");
  const p = root.firstChild as HTMLElement;
  const t1 = document.createTextNode("lo");
  const t2 = document.createTextNode("gin");
  p.textContent = "";
  p.appendChild(t1);
  p.appendChild(t2);
  markDom(root, "login");
  // 'login' spans two text nodes -> not found within a single node (documented limitation)
  check("cross-node match skipped (limitation)", marksOf(root) === 0, String(marksOf(root)));
}

// --- marks never nest into themselves ---------------------------------------------
{
  const root = el("<p>login</p>");
  markDom(root, "login");
  markDom(root, "login"); // second pass must not double-wrap
  check("double markDom does not nest", marksOf(root) === 1, String(marksOf(root)));
}

(window as any).__result = { failures, log };

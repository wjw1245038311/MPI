import { createRoot } from "react-dom/client";
import { createElement as h, useEffect, useRef } from "react";
import { Markdown } from "../../src/renderer/src/lib/markdown.tsx";
import { markDom, unmarkDom } from "../../src/renderer/src/lib/search-mark.tsx";

const sample = [
  "# Title with login",
  "",
  "Some prose about the **login** flow and LOGIN again.",
  "",
  "- item one mentions login too",
  "- item two has `inline login code`",
  "",
  "```js",
  "const x = 'login'; // comment with login",
  "```",
].join("\n");

function Probe() {
  const markRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = markRef.current;
    if (!el) {
      (window as any).__result = { failures: 1, log: ["FAIL containerRef not attached to .md"] };
      return;
    }
    const log: string[] = [];
    let failures = 0;
    const check = (name: string, cond: boolean, extra?: string) => {
      if (cond) log.push("ok   " + name);
      else {
        failures++;
        log.push("FAIL " + name + (extra ? " :: " + extra : ""));
      }
    };
    const marks = () => el.querySelectorAll("mark.chat-mark").length;

    // 1) no query -> clean render, no marks
    check("initial render has no marks", marks() === 0);
    check(
      "content rendered (h1 + p + li + code block)",
      !!el.querySelector("h1") && !!el.querySelector("p") && !!el.querySelector("li") && !!el.querySelector(".code-block"),
    );

    // 2) mark via the same path Chat.tsx uses (markDom on the .md container)
    const textBefore = el.textContent;
    markDom(el, "login");
    const count = marks();
    check("marks all occurrences in rendered markdown", count === 7, "got " + count);

    // 3) unmark restores exact visible text
    unmarkDom(el);
    check("unmark removes all marks", marks() === 0);
    check("visible text restored exactly", el.textContent === textBefore);

    (window as any).__result = { failures, log };
  }, []);
  return h(Markdown, { text: sample, containerRef: markRef });
}

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(h(Probe));

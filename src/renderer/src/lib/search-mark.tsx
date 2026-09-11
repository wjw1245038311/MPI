import { useEffect, useRef, type ReactNode } from "react";

/**
 * In-conversation search highlighting (browser find-in-page style).
 *
 * Marks are injected into the rendered DOM imperatively — never through the
 * React tree — so activating/changing a query re-renders nothing and never
 * triggers markdown re-parsing: memoized messages keep their cached output,
 * only the matched ones get a cheap TreeWalker pass over their text nodes.
 */

/** Remove all chat-search marks previously injected into `root` (idempotent). */
export function unmarkDom(root: HTMLElement): void {
  const marks = root.querySelectorAll("mark.chat-mark");
  for (const mark of Array.from(marks)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
    parent.normalize(); // merge the split text nodes back together
  }
}

function wrapMatches(textNode: Text, queryLower: string): void {
  const lower = textNode.data.toLowerCase();
  let idx = lower.indexOf(queryLower);
  if (idx === -1) return;
  const ranges: [number, number][] = [];
  while (idx !== -1) {
    ranges.push([idx, idx + queryLower.length]);
    idx = lower.indexOf(queryLower, idx + queryLower.length);
  }
  // Wrap from the end so earlier offsets stay valid.
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [start, end] = ranges[i];
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const mark = document.createElement("mark");
    mark.className = "chat-mark";
    range.surroundContents(mark);
  }
}

/** Wrap every case-insensitive occurrence of `queryLower` in root's text nodes with <mark class="chat-mark">. */
export function markDom(root: HTMLElement, queryLower: string): void {
  if (!queryLower) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    // Defensive: never descend into marks we injected ourselves.
    if (node.parentElement?.closest("mark.chat-mark")) continue;
    if (node.data.toLowerCase().includes(queryLower)) targets.push(node);
  }
  for (const node of targets) wrapMatches(node, queryLower);
}

/**
 * Ref + effect pair that keeps `query` highlighted inside the element it is
 * attached to. Re-runs when the query or the content key changes; cleans up on
 * unmount. Pass a stable string as `contentKey` (e.g. the message text) so
 * unrelated re-renders don't redo the work.
 */
export function useSearchMark(query: string | null, contentKey: unknown): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    unmarkDom(el);
    if (query) markDom(el, query.toLowerCase());
    return () => unmarkDom(el);
  }, [query, contentKey]);
  return ref;
}

/**
 * A plain div that highlights search matches in its (string) children. The
 * className is unchanged so layout/CSS behave exactly like the original div.
 */
export function MarkedDiv({
  className,
  query,
  children,
}: {
  className?: string;
  query?: string | null;
  children: ReactNode;
}) {
  const ref = useSearchMark(query ?? null, typeof children === "string" ? children : undefined);
  return (
    <div className={className} ref={ref}>
      {children}
    </div>
  );
}

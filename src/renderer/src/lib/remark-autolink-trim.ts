/**
 * GFM autolink literals greedily include non-ASCII characters (e.g. CJK) as
 * part of a URL, so `读https://foo.com/x，然后解决` becomes one giant link whose
 * href is percent-encoded garbage. Split the trailing non-ASCII run back out
 * into plain text after the link node.
 *
 * Only autolink literals are touched: explicit `[text](url)` links keep their
 * URL as written (the user typed it deliberately). Ported from
 * pi-agent-desktop PR #51/#54 (issue #50).
 */

interface MdastNodeLike {
  type?: string;
  url?: string;
  value?: string;
  children?: MdastNodeLike[];
}

export function remarkTrimAutolinkTrailingUnicode() {
  return (tree: unknown) => {
    const walk = (node: MdastNodeLike | undefined) => {
      if (!node || typeof node !== "object" || !Array.isArray(node.children)) return;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const textChild = child.children?.[0];
        // Autolink literal: a link whose only child is text identical to the url.
        if (
          child.type === "link" &&
          typeof child.url === "string" &&
          child.children?.length === 1 &&
          textChild?.type === "text" &&
          textChild.value === child.url
        ) {
          const match = /[^\x00-\x7F]/u.exec(child.url);
          if (match && match.index > 0) {
            const kept = child.url.slice(0, match.index);
            const tail = child.url.slice(match.index);
            child.url = kept;
            textChild.value = kept;
            node.children.splice(i + 1, 0, { type: "text", value: tail });
          }
        }
        walk(child);
      }
    };
    walk(tree as MdastNodeLike);
  };
}

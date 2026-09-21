/**
 * Markdown 解析管线（纯函数，无 store/window 依赖——可被 node 测试直接 import）。
 *
 * 复刻 react-markdown v9 的同步渲染路径：unified(remarkParse → remark 插件 →
 * remarkRehype{allowDangerousHtml} → rehype 插件).runSync → post（raw 兜底 +
 * URL 消毒 + hast-util-to-jsx-runtime）。见 node_modules/react-markdown/lib/
 * index.js 的 Markdown/createProcessor/post。行为等价由构造保证：插件列表与
 * react-markdown 默认选项逐项一致；唯一差异是不传 passNode（我们的组件不用
 * hast node，省一份树引用）——静态输出不受影响。
 *
 * 拆成独立模块的原因：markdown.tsx 的解析缓存需要跨挂载复用管线产物，而
 * markdown.tsx 依赖 store/window 无法在 node 里验证；本模块可被
 * scripts/test-md-pipeline.mjs 直接 import，与 react-markdown 原库对拍。
 */
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { ReactNode } from "react";
import { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import { CODE_LANGUAGE_ALIASES, CODE_LANGUAGE_NAMES, CODE_LANGUAGES } from "./code-languages";
import { remarkTrimAutolinkTrailingUnicode } from "./remark-autolink-trim";

// Module-level constants: markdown parsing + highlight.js is the single most
// expensive thing the renderer does. The processor must be created once and
// reused (react-markdown rebuilds it on every render — we don't pay that).
// The trim plugin must run after gfm (it fixes autolink literals gfm produced).
export const REMARK_PLUGINS = [remarkGfm, remarkTrimAutolinkTrailingUnicode];

// rehype-raw enables inline HTML in markdown (READMEs use <table>/<img> for
// screenshot grids). Raw markup can carry event-handler attributes — react-
// markdown v9 does not filter those itself, so strip on* props before render.
function stripEventProps(node: any): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "element" && node.properties) {
    for (const key of Object.keys(node.properties)) {
      if (/^on/i.test(key)) delete node.properties[key];
    }
  }
  if (Array.isArray(node.children)) node.children.forEach(stripEventProps);
}
const rehypeStripEvents = () => (tree: any) => stripEventProps(tree);

export const REHYPE_PLUGINS = [
  // Must run first: turns raw HTML text nodes into real elements so the rest
  // of the pipeline (and our component overrides, e.g. local <img>) sees them.
  rehypeRaw,
  rehypeStripEvents,
  // GitHub-style heading ids so in-document anchor links (e.g. the user
  // manual's table of contents) can jump to headings inside the app.
  rehypeSlug,
  [
    rehypeHighlight,
    {
      aliases: CODE_LANGUAGE_ALIASES,
      // Detect unlabeled fenced blocks after checking explicit languages. This
      // makes copied shell/code snippets useful while keeping the subset small.
      detect: true,
      languages: CODE_LANGUAGES,
      subset: CODE_LANGUAGE_NAMES,
    },
  ],
] as any;

const mdProcessor = unified()
  .use(remarkParse)
  .use(REMARK_PLUGINS as any)
  .use(remarkRehype, { allowDangerousHtml: true }) // react-markdown 的默认 remarkRehypeOptions
  .use(REHYPE_PLUGINS as any);

/** post() 复刻：残留 raw 节点转文本 + URL 属性消毒（defaultUrlTransform）+ hast→React。 */
function postMd(tree: any, components: Record<string, unknown>): ReactNode {
  visit(tree, (node: any, index: number | undefined, parent: any) => {
    if (node.type === "raw" && parent && typeof index === "number") {
      // rehype-raw 之后正常不会剩 raw；与 react-markdown 一致地兜底转文本
      parent.children[index] = { type: "text", value: node.value };
      return index as any;
    }
    if (node.type === "element" && node.properties) {
      for (const key in urlAttributes) {
        const test = (urlAttributes as Record<string, string[] | null>)[key];
        if (Object.hasOwn(urlAttributes, key) && Object.hasOwn(node.properties, key)) {
          if (test === null || test.includes(node.tagName)) {
            // 默认实现只用第一个参数（类型也只声明一个）
            node.properties[key] = defaultUrlTransform(String(node.properties[key] || ""));
          }
        }
      }
    }
  });
  return toJsxRuntime(tree as any, {
    Fragment,
    components: components as any,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    // 不传 passNode：我们的组件不用 hast node，省一份树引用
  }) as ReactNode;
}

/** 同步渲染 markdown → React 元素树（= react-markdown v9 Markdown 组件的内部路径）。 */
export function renderMd(src: string, components: Record<string, unknown>): ReactNode {
  const file = new VFile();
  file.value = src;
  return postMd(mdProcessor.runSync(mdProcessor.parse(file), file) as any, components);
}

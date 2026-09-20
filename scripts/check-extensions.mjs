/**
 * 扩展语法检查（tsconfig 覆盖不到它们！）
 *
 * src/main/mpi-*-ext.ts 以 `?raw` 源码打进主进程、由 pi 自己的 jiti 在运行时转译，
 * 因此被 tsconfig.node.json 排除（pi/typebox 只存在于 pi runtime）。
 * 后果：**它们不会经过 tsc**，写错语法要到运行时才炸。本脚本用 esbuild 解析一遍兜住。
 * 运行：npm run check:ext
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { transform } from "esbuild";

const DIR = "src/main";
const files = readdirSync(DIR).filter((f) => f.endsWith("-ext.ts"));
if (!files.length) {
  console.error("没找到任何 *-ext.ts，检查路径");
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const p = join(DIR, f);
  try {
    await transform(readFileSync(p, "utf8"), { loader: "ts", target: "es2022" });
    console.log(`  ✅ ${f}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${f}\n     ${(e.errors?.[0]?.text || e.message || "").split("\n")[0]}`);
    const loc = e.errors?.[0]?.location;
    if (loc) console.error(`     位置：${p}:${loc.line}:${loc.column}`);
  }
}

if (failed) {
  console.error(`\ncheck:ext 失败：${failed}/${files.length} 个扩展有语法错误`);
  process.exit(1);
}
console.log(`\ncheck:ext 通过（${files.length} 个扩展）`);

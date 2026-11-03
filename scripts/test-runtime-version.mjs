/**
 * 运行时版本判定（L1）：`src/shared/runtime-version.ts`。
 *
 * 锁三条：
 *   ① 只有内置**严格更新**才换上（不降级、同版本不动）；
 *   ② 没有现役运行时 → 交给首次解压的既有路径，这里不重复安装；
 *   ③ 版本号比较按数字段（1.10.0 > 1.9.9），忽略 v 前缀与预发布后缀。
 *
 * 真正的「拷贝归档 → sha512 校验 → tar 解压 → 改 current.json」在
 * `src/main/runtime-package.ts`（依赖 electron / tar），只能实机验证。
 */
import assert from "node:assert/strict";
import { compareRuntimeVersions, shouldAdoptEmbeddedRuntime } from "../src/shared/runtime-version.ts";

// --- 版本比较 ------------------------------------------------------------------
assert.equal(compareRuntimeVersions("1.5.0", "1.3.0"), 1);
assert.equal(compareRuntimeVersions("1.3.0", "1.5.0"), -1);
assert.equal(compareRuntimeVersions("1.5.0", "1.5.0"), 0);
assert.equal(compareRuntimeVersions("v1.5.0", "1.5.0"), 0, "v 前缀不影响");
assert.equal(compareRuntimeVersions("1.10.0", "1.9.9"), 1, "按数字段比较而不是字符串");
assert.equal(compareRuntimeVersions("1.5", "1.5.0"), 0, "缺省段视为 0");
assert.equal(compareRuntimeVersions("1.5.1-rc.2", "1.5.0"), 1, "预发布后缀不影响数字段");
assert.equal(compareRuntimeVersions(null, "1.5.0"), -1, "没有现役版本视为最低");
assert.equal(compareRuntimeVersions("", ""), 0);

// --- 换不换 -------------------------------------------------------------------
assert.equal(shouldAdoptEmbeddedRuntime("1.3.0", "1.5.0"), true, "内置更新 → 静默换上");
assert.equal(shouldAdoptEmbeddedRuntime("1.5.0", "1.5.0"), false, "同版本不动");
assert.equal(shouldAdoptEmbeddedRuntime("1.5.0", "1.4.0"), false, "内置更旧 → 绝不降级");
assert.equal(shouldAdoptEmbeddedRuntime(null, "1.5.0"), false, "没有现役运行时交给首次解压路径");
assert.equal(shouldAdoptEmbeddedRuntime("1.3.0", null), false, "没有内置归档（dev / 旧安装包）不动");
assert.equal(shouldAdoptEmbeddedRuntime(null, null), false);

console.log("runtime-version: 全部检查通过");

/**
 * 「更新 Pi」路由决策（src/main/core-updater.ts 的 shouldInstallEmbeddedRuntime）。
 *
 * 规则来自一次真实升级：pi 1.x 的 npm 包不再带 npm-shrinkwrap.json，原来的
 * 「下载 tarball → 按锁装依赖」路径对 1.x 根本走不通；而 MPI 安装包自带的运行时归档是
 * 打包时生成、带 size/sha512 校验的完整树。所以：**设备版本低于内置版本就直接装内置**。
 */
import assert from "node:assert/strict";
import { register } from "node:module";

// core-updater → runtime-package 会拉 electron，这个 loader 同时补 .ts 后缀。
register(new URL("./electron-stub-loader.mjs", import.meta.url));
const { shouldInstallEmbeddedRuntime } = await import("../src/main/core-updater.ts");

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  ✓ ${m}`);
};

// 设备比内置旧 ⇒ 直接吃内置（离线、有校验、不碰 registry）
assert.equal(shouldInstallEmbeddedRuntime("0.87.0", "1.2.0", "1.2.0"), true, "要的就是内置版本");
assert.equal(shouldInstallEmbeddedRuntime("0.87.0", "1.2.0", "1.3.0"), true, "上游更新但设备比内置旧：先装内置");
assert.equal(shouldInstallEmbeddedRuntime(null, "1.2.0", "1.3.0"), true, "本机还没有可用运行时：装内置");
assert.equal(shouldInstallEmbeddedRuntime("0.99.0", "1.0.0", "1.4.0"), true, "跨 1.0 边界同样按新旧判断");
ok("设备版本低于内置 ⇒ 走内置归档");

// 设备已经是内置版本，且上游更靠前 ⇒ 才需要走 registry
assert.equal(shouldInstallEmbeddedRuntime("1.2.0", "1.2.0", "1.3.0"), false, "已等于内置：该去 registry 拿更新版");
assert.equal(shouldInstallEmbeddedRuntime("1.3.0", "1.2.0", "1.4.0"), false, "设备比内置还新：不要降级回去");
ok("设备不低于内置 ⇒ 不安装内置（避免把用户降回旧版）");

// 没有内置归档（dev / 旧发行版）⇒ 一律走原路径
assert.equal(shouldInstallEmbeddedRuntime("0.87.0", null, "1.2.0"), false, "无内置归档时不假装能装");
assert.equal(shouldInstallEmbeddedRuntime(null, null, "1.2.0"), false, "无内置归档 + 无当前版本也不动");
ok("缺内置归档时保持旧行为");

// 数字比较而不是字符串比较（1.10 > 1.9）
assert.equal(shouldInstallEmbeddedRuntime("1.10.0", "1.9.0", "1.11.0"), false, "按语义化版本比较，不按字典序");
assert.equal(shouldInstallEmbeddedRuntime("1.9.0", "1.10.0", "1.11.0"), true, "1.9 < 1.10");
ok("版本号按数字段比较（1.10 > 1.9）");

console.log(`\ncore-update-route 测试通过：${n} 项`);

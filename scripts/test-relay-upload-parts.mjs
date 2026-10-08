/**
 * relay-upload 分片规划（纯逻辑，L1）。
 *
 * 覆盖 planParts 的边界（空文件 / 单段 / 分段完整性 / 段数超过字节数）与 partName 命名，
 * 并交叉断言 scripts/relay-upload.mjs 确实用了这套规划（防止工具侧悄悄退回整文件 scp）。
 * 真实并发上传跑不了 L1（要 SSH 到 ECS），靠发版时观察日志与 sha256 校验。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PARTS,
  PARALLEL_THRESHOLD_BYTES,
  partName,
  planParts,
  shouldSplit,
} from "./relay-upload-parts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

// --- 单段：空文件 / 关掉分片 / 小于阈值 -------------------------------------------
assert.deepEqual(planParts(0, 12), []);
assert.deepEqual(planParts(1024, 1), [{ index: 0, start: 0, end: 1023 }]);
assert.deepEqual(planParts(1024, 12), [{ index: 0, start: 0, end: 1023 }]);
assert.deepEqual(planParts(PARALLEL_THRESHOLD_BYTES - 1, 12), [
  { index: 0, start: 0, end: PARALLEL_THRESHOLD_BYTES - 2 },
]);

// --- 多段：区间连续、无重叠、总长守恒（threshold=0 才强制分段，否则小文件按约定不分） ---
for (const [size, parts] of [[143_758_565, 12], [12, 5], [100, 3], [1_000_000, 7]]) {
  const plan = planParts(size, parts, 0);
  assert.equal(plan.length, Math.min(parts, size), `size=${size} parts=${parts} 段数`);
  assert.equal(plan[0].start, 0);
  assert.equal(plan.at(-1).end, size - 1, "最后一段必须吃到结尾");
  let covered = 0;
  for (let i = 0; i < plan.length; i += 1) {
    assert.equal(plan[i].index, i);
    if (i > 0) assert.equal(plan[i].start, plan[i - 1].end + 1, "段必须紧邻无缝隙");
    assert.ok(plan[i].end >= plan[i].start, "不允许空段");
    covered += plan[i].end - plan[i].start + 1;
  }
  assert.equal(covered, size, `size=${size} 覆盖字节数守恒`);
}

// --- 分片数超过字节数时退化为 1 字节/段，不产出空段 --------------------------------
assert.deepEqual(planParts(3, 12, 0), [
  { index: 0, start: 0, end: 0 },
  { index: 1, start: 1, end: 1 },
  { index: 2, start: 2, end: 2 },
]);

// --- 阈值作用：默认阈值下小文件就是单段（不要为了“多段”而多段） -----------------------
assert.equal(planParts(12, 5).length, 1, "默认阈值下 12 字节不应分段");
assert.equal(planParts(PARALLEL_THRESHOLD_BYTES, 12).length, 12, "达阈值才分段");

// --- 阈值只影响「要不要分」，不影响区间计算 ---------------------------------------
assert.equal(shouldSplit(PARALLEL_THRESHOLD_BYTES, 12), true);
assert.equal(shouldSplit(PARALLEL_THRESHOLD_BYTES - 1, 12), false);
assert.equal(shouldSplit(143_758_565, 1), false, "--parts 1 等于关掉分片");

// --- 命名与工具侧接线 -------------------------------------------------------------
assert.equal(partName("MPI-Setup-0.9.7.exe.uploading", 0), "MPI-Setup-0.9.7.exe.uploading.part00");
assert.equal(partName("x", 11), "x.part11");

const tool = read("scripts", "relay-upload.mjs");
assert.match(tool, /relay-upload-parts\.mjs/, "工具必须import规划模块（而不是自己算区间）");
assert.match(tool, /planParts\(/, "工具必须用 planParts");
assert.match(tool, /sha256sum/, "上传后必须远端校验 sha256");
assert.match(tool, /latest\.yml/, "latest.yml 必须最后落盘（排序依据）");
assert.match(tool, /\.uploading/, "必须传临时名再原子替换，避免半包上线");
// 并发上传偶有单条被掐断（sshd MaxStartups），必须重试
assert.match(tool, /uploadPartWithRetry/, "分片上传必须有重试");
// 路径安全：远端目录走 env，并在被 MSYS 改写时直接报错
assert.match(tool, /MPI_RELAY_APP_DIR/, "远端目录必须支持 env 传入（避开 Git Bash 路径改写）");
assert.match(tool, /Windows 路径/, "必须拦下被 MSYS 改写的远端目录");
assert.equal(DEFAULT_PARTS, 12, "默认并发数应与实测结论一致（12 路 ≈7MB/s）");

// 走哪条路：公网 443 才并发有效（tailnet 是单条 DERP 隧道，多少路都 ~0.8MB/s）
const publisher = read("scripts", "publish-release.mjs");
assert.match(publisher, /relay-upload\.mjs/, "publish-release 必须调用并行上传工具");
assert.match(publisher, /RELAY_UPLOAD_HOST = process\.env\.MPI_RELAY_UPLOAD_HOST \|\| 'root@47\.97\.28\.110'/, "默认上传路应为 ECS 公网");
assert.match(publisher, /RELAY_UPLOAD_PORT = process\.env\.MPI_RELAY_UPLOAD_PORT \|\| '443'/, "默认上传端口应为 443");
assert.match(publisher, /回退 tailnet/, "快路失败必须回退 tailnet 慢路");
assert.match(publisher, /MPI_RELAY_APP_DIR: RELAY_APP_DIR/, "远端目录必须通过 spawn env 传（不经 bash）");
assert.doesNotMatch(publisher, /scp .*\$\{quoted\}/, "旧的整包 scp 路径应已移除");
// 小版本不推 GitHub
assert.match(publisher, /--no-github/, "publish-release 必须支持 --no-github");
const devRelease = read("scripts", "dev-release.mjs");
assert.match(devRelease, /args\.push\("--no-github"\)/, "dev-release 小版本必须自动带上 --no-github");
assert.match(devRelease, /const pushesGithub = RELEASE_KIND !== "patch"/, "只有非 patch（大版本）才推 GitHub");

console.log("relay-upload-parts: 全部检查通过");

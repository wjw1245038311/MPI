#!/usr/bin/env node
/**
 * chat-attachments-maintenance.mjs —— 附件区维护工具（存量去重 / 引用感知 GC / 盘点）。
 *
 * 为什么需要它：附件区过去只有「按 mtime 删到 1GB 以内」一种整理方式，会把还在被会话引用的
 * 视频删掉（历史消息退化成占位卡片）。而现在（P2）容器里还躺着 2026-09-29 那次落盘错位事故
 * 产生的**同内容多份副本**（块序不同，所以按内容哈希看不出重复），需要显式合并。
 *
 * 用法（默认都是 dry-run，加 --apply 才落盘）：
 *   node --experimental-transform-types scripts/chat-attachments-maintenance.mjs \
 *     --user-data "<userData 目录>" [--report] [--gc --max-mb 1024] \
 *     [--merge <保留的名字> <重复的名字> ...] [--apply]
 *
 * 安全边界：
 *   · 只碰 `<userData>/chat-attachments`（含 objects/ 与 index.json），不碰会话文件；
 *   · 合并不是删数据：重复副本的名字会写进 index.json 的 `aliases`，历史消息照旧解析；
 *   · 合并前**逐 4MB 块**校验两份是同一内容的置换（块序可不同），校验不过直接拒绝；
 *   · GC 只删「没有任何会话引用」的附件；引用集合读不到就一个都不删。
 *
 * 为什么用 MPI_TEST_USER_DATA 而不是命令行参数直接拼路径：主进程模块通过 electron 的
 * `app.getPath("userData")` 取路径，测试用的 stub 认这个环境变量——这样工具与运行时**走的是
 * 同一套路径解析**，不会出现「工具处理了 A 目录、应用读的是 B 目录」。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const userData = valueOf("--user-data");
const apply = has("--apply");
const maxMb = Number(valueOf("--max-mb") || 1024);
const mergeIndex = argv.indexOf("--merge");
const mergeArgs = mergeIndex >= 0 ? argv.slice(mergeIndex + 1).filter((a) => !a.startsWith("--")) : [];
const sessionsRoot = valueOf("--sessions");

if (!userData) {
  console.error('缺少 --user-data（例如 --user-data "C:\\Users\\<你>\\AppData\\Roaming\\MPI Dev"）');
  process.exit(64);
}
if (!existsSync(userData)) {
  console.error(`userData 目录不存在：${userData}`);
  process.exit(66);
}
process.env.MPI_TEST_USER_DATA = userData;
process.env.MPI_TEST_TEMP ||= join(userData, "sys-temp");

const store = await import("../src/main/chat-attachment-store.ts");
const { collectReferencedAttachmentNames } = await import("../src/main/attachment-gc.ts");
const ATTACHMENTS_DIR = join(userData, "chat-attachments");
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
const log = (m) => console.log(m);

log(`附件区：${ATTACHMENTS_DIR}${apply ? "" : "（dry-run：不会改动任何文件，加 --apply 才落盘）"}`);

// ---- 盘点 ----
if (!has("--gc") && !has("--merge")) {
  const report = store.attachmentStorageReport();
  log(`  总量   ${mb(report.totalBytes)}（对象 ${report.objectCount} 个 / ${mb(report.objectBytes)}；` +
    `遗留平铺 ${report.legacyCount} 个 / ${mb(report.legacyBytes)}；别名 ${report.aliasCount} 条）`);
  // 列出遗留平铺视频（存量去重的候选）与它们的体积
  const target = ATTACHMENTS_DIR;
  const legacy = readdirSync(target).filter((name) => /\.(mp4|m4v|webm|mov|mkv|avi)$/i.test(name));
  if (legacy.length) {
    log("  遗留平铺视频：");
    for (const name of legacy) {
      log(`    ${mb(statSync(join(target, name)).size).padStart(9)}  ${name}`);
    }
  }
  const strings = await collectReferencedAttachmentNames({ ...(sessionsRoot ? { sessionsRoot } : {}) });
  log(strings ? `  会话引用：${strings.size} 个名字` : "  会话引用：读不到（GC 会一个都不删）");
  log("\n下一步建议：对同一份内容的多个副本用 --merge <保留> <重复...> --apply 合并（先不加 --apply 看校验结果）");
  process.exit(0);
}

// ---- 合并副本 ----
if (mergeArgs.length >= 2) {
  const [keep, ...duplicates] = mergeArgs;
  log(`\n[合并] 保留 ${keep}`);
  for (const dup of duplicates) log(`        合并 ${dup}`);
  const result = store.mergeDuplicateAttachments(keep, duplicates, { apply });
  if (!result.ok) {
    console.error(`  ✗ 拒绝合并：${result.reason}（不改动任何文件）`);
    process.exit(1);
  }
  log(`  ✓ 校验通过（同一内容的块序置换），key=${result.key}`);
  if (apply) {
    log(`  ✓ 已合并 ${result.merged.length} 份，回收 ${mb(result.reclaimedBytes)}；` +
      `${result.aliased.length} 个老名字已写进别名表（历史消息照旧解析）`);
  } else {
    log(`  （dry-run）预计回收 ${mb(result.reclaimedBytes)}`);
  }
}

// ---- GC ----
if (has("--gc")) {
  log(`\n[GC] 上限 ${maxMb}MB，只清无会话引用的附件`);
  const referenced = await collectReferencedAttachmentNames({ ...(sessionsRoot ? { sessionsRoot } : {}) });
  const report = await store.pruneChatAttachments(maxMb * 1024 * 1024, {
    collectReferenced: async () => referenced,
  });
  log(`  引用集合：${referenced ? `${referenced.size} 个名字` : "不可用（未删任何文件）"}`);
  log(`  清掉 ${report.removed.length} 个，回收 ${mb(report.freedBytes)}；保护 ${mb(report.protectedBytes)}`);
  log(`  剩余 ${mb(report.totalBytes)} / 上限 ${mb(report.maxBytes)}${report.overCapacity ? " → ⚠️ 仍超上限" : ""}`);
  if (report.overCapacity) {
    log("  超上限说明：剩下的都被会话引用着。要腾空间只能删掉不再看的会话，或调大上限。");
  }
}

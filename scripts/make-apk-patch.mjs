// 生成 MPI 增量包（APK 差量）：old + patch → new。
//
// 用法：
//   node scripts/make-apk-patch.mjs <oldApk> <newApk> [outPatch]
//
// 格式与客户端 mobile/app/.../data/ApkPatch.kt 严格一致：
//   "MPIPATCH1"(9) + newSize(int64 LE) + zlib(deflate) 指令流
//   指令：0x00 END / 0x01 COPY(srcOffset int32 LE, len int32 LE) / 0x02 ADD(len int32 LE, bytes)
//
// 算法：块匹配（rsync 风格，块 4KB）——比 bsdiff 简单得多，不需要后缀排序。
// 对「同一版本线、小改动」的 APK 效果好；跨大版本时 patch 会接近全量，这时
// 客户端应直接下完整包（清单里会给出两者，客户端按体积择优）。
//
// 自检：脚本会把生成的 patch 自己解码一遍，比对 newApk 的 sha256；不一致就报错退出。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const BLOCK = 4096;
const MAGIC = "MPIPATCH1";

function fnv1a(buf, offset, len) {
  let h = 0x811c9dc5;
  for (let i = 0; i < len; i++) {
    h ^= buf[offset + i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ---- 指令生成 -------------------------------------------------------------

function buildInstructions(oldBuf, newBuf) {
  const index = new Map();
  for (let off = 0; off + BLOCK <= oldBuf.length; off += BLOCK) {
    const h = fnv1a(oldBuf, off, BLOCK);
    const list = index.get(h);
    if (list) list.push(off);
    else index.set(h, [off]);
  }

  const chunks = [];
  let pending = [];
  const flushAdd = () => {
    if (!pending.length) return;
    const bytes = Buffer.concat(pending);
    const head = Buffer.alloc(5);
    head.writeUInt8(2, 0);
    head.writeInt32LE(bytes.length, 1);
    chunks.push(head, bytes);
    pending = [];
  };

  let pos = 0;
  let copied = 0;
  let added = 0;
  while (pos < newBuf.length) {
    const remaining = newBuf.length - pos;
    if (remaining >= BLOCK) {
      const h = fnv1a(newBuf, pos, BLOCK);
      const candidates = index.get(h);
      let match = -1;
      if (candidates) {
        for (const off of candidates) {
          if (newBuf.compare(oldBuf, off, off + BLOCK, pos, pos + BLOCK) === 0) {
            match = off;
            break;
          }
        }
      }
      if (match >= 0) {
        let len = BLOCK;
        while (
          match + len < oldBuf.length &&
          pos + len < newBuf.length &&
          oldBuf[match + len] === newBuf[pos + len]
        ) {
          len++;
        }
        flushAdd();
        const head = Buffer.alloc(9);
        head.writeUInt8(1, 0);
        head.writeInt32LE(match, 1);
        head.writeInt32LE(len, 5);
        chunks.push(head);
        copied += len;
        pos += len;
        continue;
      }
    }
    const take = Math.min(BLOCK, remaining);
    pending.push(newBuf.subarray(pos, pos + take));
    added += take;
    pos += take;
  }
  flushAdd();
  chunks.push(Buffer.from([0]));
  return { instructions: Buffer.concat(chunks), copied, added };
}

// ---- 自检：把 patch 解回 new -------------------------------------------------

function verify(patch, oldBuf) {
  if (patch.subarray(0, MAGIC.length).toString("ascii") !== MAGIC) throw new Error("magic 不对");
  const newSize = Number(patch.readBigInt64LE(MAGIC.length));
  const raw = inflateSync(patch.subarray(MAGIC.length + 8));
  const out = Buffer.alloc(newSize);
  let oi = 0;
  let ri = 0;
  while (true) {
    const op = raw.readUInt8(ri++);
    if (op === 0) break;
    if (op === 1) {
      const src = raw.readInt32LE(ri); ri += 4;
      const len = raw.readInt32LE(ri); ri += 4;
      oldBuf.copy(out, oi, src, src + len);
      oi += len;
    } else if (op === 2) {
      const len = raw.readInt32LE(ri); ri += 4;
      raw.copy(out, oi, ri, ri + len);
      ri += len;
      oi += len;
    } else {
      throw new Error(`未知指令 ${op}`);
    }
  }
  if (oi !== newSize) throw new Error(`长度不符：期望 ${newSize}，实得 ${oi}`);
  return out;
}

// ---- main -----------------------------------------------------------------

function main() {
  const [oldPath, newPath, outArg] = process.argv.slice(2);
  if (!oldPath || !newPath) {
    console.error("usage: node scripts/make-apk-patch.mjs <oldApk> <newApk> [outPatch]");
    process.exit(64);
  }
  if (!existsSync(oldPath) || !existsSync(newPath)) {
    console.error("找不到输入文件（old/new 都要存在）");
    process.exit(66);
  }

  const oldBuf = readFileSync(oldPath);
  const newBuf = readFileSync(newPath);
  const started = Date.now();
  const { instructions, copied, added } = buildInstructions(oldBuf, newBuf);
  const deflated = deflateSync(instructions, { level: 9 });

  const header = Buffer.alloc(17);
  header.write(MAGIC, 0, "ascii");
  header.writeBigInt64LE(BigInt(newBuf.length), MAGIC.length);
  const patch = Buffer.concat([header, deflated]);

  // 自检：解回来必须与 newApk 逐字节一致
  const restored = verify(patch, oldBuf);
  const ok = sha256(restored) === sha256(newBuf);
  if (!ok) {
    console.error("自检失败：patch 还原结果与 newApk 不一致，已放弃输出");
    process.exit(1);
  }

  const outPath =
    outArg ||
    newPath.replace(/(\.apk)?$/i, "") + `.from-${oldBuf.length}-patch`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, patch);

  const pct = ((patch.length / newBuf.length) * 100).toFixed(1);
  console.log(`old      : ${oldPath} (${oldBuf.length} bytes)`);
  console.log(`new      : ${newPath} (${newBuf.length} bytes)`);
  console.log(`patch    : ${outPath} (${patch.length} bytes, 完整包的 ${pct}%)`);
  console.log(`指令     : COPY ${copied} bytes / ADD ${added} bytes`);
  console.log(`自检     : ✅ 还原后 sha256 与 newApk 一致`);
  console.log(`耗时     : ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`sha256   : ${sha256(patch)}`);
  console.log(`newSha256: ${sha256(newBuf)}`);
}

main();

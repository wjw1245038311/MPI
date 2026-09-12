/**
 * Edge TTS 真实网络冒烟（dev 诊断用，不进 npm test）：
 *   node scripts/edge-tts-live-check.mjs
 * 直接调用 src/main/edge-tts.ts 的 synthesizeEdge（注入 ws），验证当前
 * Chromium 版本号 / GEC token / SSML 协议对微软端点是否仍然有效。
 * 若 ok=false 且 error 含 403/closed → 多半是微软又升了客户端版本，
 * 需把 src/main/edge-tts.ts 的 CHROMIUM_FULL_VERSION 升到当前 Edge 版本。
 */
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

const m = await import("../src/main/edge-tts.ts");
const WS = (await import("ws")).default;

const CASES = [
  ["你好，世界。这是 MPI 的 Edge TTS 协议验证。", "zh-CN-XiaoxiaoNeural"],
  ["Hello world. This is an Edge TTS protocol check.", "en-US-AriaNeural"],
];

let failed = 0;
for (const [text, voice] of CASES) {
  const t0 = Date.now();
  const r = await m.synthesizeEdge({ text, voice }, { wsImpl: WS });
  const ms = Date.now() - t0;
  if (r.ok && r.audioBase64) {
    const bytes = Buffer.from(r.audioBase64, "base64").length;
    console.log(`✓ ${voice} ok (${ms}ms, ${bytes}B mp3)`);
  } else {
    failed++;
    console.log(`✗ ${voice} FAIL (${ms}ms): ${r.error}`);
  }
}

if (failed) {
  console.error("\nEdge TTS live check FAILED — 检查 src/main/edge-tts.ts 的 CHROMIUM_FULL_VERSION 是否过旧。");
  process.exit(1);
}
console.log("\nEdge TTS live check OK（协议版本对当前端点有效）");

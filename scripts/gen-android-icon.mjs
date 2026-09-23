/**
 * 由桌面端图标（resources/icon.png）生成安卓启动图标资源。
 *
 * 为什么需要脚本：图标是位图，安卓各密度要各自的 PNG；本机没有 ImageMagick/ffmpeg，
 * 但仓库里有 `pngjs`，用它做盒式滤波缩放足够（且可复现）。
 *
 * 两个关键处理：
 * - **黑线转「黑色 + alpha」**：源图是白底黑线。直接当图层用会出现白底方块；
 *   而按亮度取反成 alpha（alpha = 255 - 亮度）能完整保留抗锯齿，放在任何底色上都对。
 * - **缩进安全区**：自适应图标是 108dp 画布、可见区约 72dp、保证区 66dp。
 *   源图自带留白，整体缩到画布的 86% 并居中，让笔画落在保证区内，圆形遮罩也不会切到。
 *
 * 跑法：node scripts/gen-android-icon.mjs
 * 产物：mobile/app/app/src/main/res/mipmap-<density>/ic_launcher_foreground.png + 预览图
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "resources", "icon.png");
const RES = join(ROOT, "mobile", "app", "app", "src", "main", "res");

/** 自适应图标各密度下的画布边长（dp = px at mdpi）。 */
const DENSITIES = [
  ["mdpi", 108],
  ["hdpi", 162],
  ["xhdpi", 216],
  ["xxhdpi", 324],
  ["xxxhdpi", 432],
];

/** 源图占画布的比例（留出安全区）。 */
const ARTWORK_RATIO = 0.86;

const source = PNG.sync.read(readFileSync(SOURCE));
console.log(`源图：${source.width}×${source.height}`);

/**
 * 盒式滤波：把源图的一个矩形区域平均成目标像素。
 * 大面积缩小时比最近邻干净得多（笔画边缘不会碎）。
 */
function sampleAverage(x0, y0, x1, y1) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const px = Math.min(source.width - 1, Math.max(0, x));
      const py = Math.min(source.height - 1, Math.max(0, y));
      const index = (py * source.width + px) * 4;
      r += source.data[index];
      g += source.data[index + 1];
      b += source.data[index + 2];
      count += 1;
    }
  }
  if (!count) return { r: 255, g: 255, b: 255 };
  return { r: r / count, g: g / count, b: b / count };
}

function render(size) {
  const out = new PNG({ width: size, height: size });
  out.data.fill(0); // 全透明

  const artworkSize = size * ARTWORK_RATIO;
  const offset = (size - artworkSize) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      const insideArtwork =
        x >= offset && x < offset + artworkSize && y >= offset && y < offset + artworkSize;
      if (!insideArtwork) continue; // 画布留白保持透明

      // 映射到源图坐标
      const sx0 = ((x - offset) / artworkSize) * source.width;
      const sy0 = ((y - offset) / artworkSize) * source.height;
      const sx1 = ((x + 1 - offset) / artworkSize) * source.width;
      const sy1 = ((y + 1 - offset) / artworkSize) * source.height;

      const { r, g, b } = sampleAverage(sx0, sy0, sx1, sy1);
      // 白底黑线 → 黑色 + alpha：越暗越不透明，抗锯齿天然保留
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const alpha = Math.round(255 - luminance);
      if (alpha <= 2) continue;
      out.data[index] = 0;
      out.data[index + 1] = 0;
      out.data[index + 2] = 0;
      out.data[index + 3] = alpha;
    }
  }
  return out;
}

for (const [density, size] of DENSITIES) {
  const dir = join(RES, `mipmap-${density}`);
  mkdirSync(dir, { recursive: true });
  const png = render(size);
  writeFileSync(join(dir, "ic_launcher_foreground.png"), PNG.sync.write(png));
  console.log(`写出 mipmap-${density}/ic_launcher_foreground.png（${size}×${size}）`);
}

// 预览：模拟圆形遮罩下的观感（背景白色，与桌面图标底色一致）
{
  const size = 432;
  const png = render(size);
  const preview = new PNG({ width: size, height: size });
  const center = size / 2;
  const radius = size / 2 - 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      const inCircle = (x - center) ** 2 + (y - center) ** 2 <= radius ** 2;
      // 白底 + 圆形遮罩内的前景
      let r = 255;
      let g = 255;
      let b = 255;
      const fgAlpha = png.data[index + 3] / 255;
      if (inCircle) {
        r = Math.round(255 * (1 - fgAlpha) + png.data[index] * fgAlpha);
        g = Math.round(255 * (1 - fgAlpha) + png.data[index + 1] * fgAlpha);
        b = Math.round(255 * (1 - fgAlpha) + png.data[index + 2] * fgAlpha);
      }
      preview.data[index] = r;
      preview.data[index + 1] = g;
      preview.data[index + 2] = b;
      preview.data[index + 3] = 255;
    }
  }
  const out = join(ROOT, "tempfile", "mobile-harness", "icon-preview.png");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, PNG.sync.write(preview));
  console.log(`预览：${out}`);
}

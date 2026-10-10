/** 拖拽 / 粘贴进来的文件按类型分通道（纯函数，node 可单测）。
 *
 * - image/* → images：客户端压缩后内联，模型直接看图（主机上限 3）
 * - video/* → videos：视频专用通道，直连上传优先可到 128MB（主机上限 1）
 * - 其余    → files：base64 原样内联，主机落盘后交给 agent 读（每个 ≤6MB、上限 3）
 */
export interface RoutedDrop {
  images: File[];
  videos: File[];
  files: File[];
}

export function routeDroppedFiles(list: Iterable<File>): RoutedDrop {
  const out: RoutedDrop = { images: [], videos: [], files: [] };
  for (const file of list) {
    if (!file) continue;
    const type = (file.type || "").toLowerCase();
    if (type.startsWith("image/")) out.images.push(file);
    else if (type.startsWith("video/")) out.videos.push(file);
    else out.files.push(file);
  }
  return out;
}

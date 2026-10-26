// 路径取名工具（渲染层共用）。
//
// 为什么不用 new RegExp 拼反斜杠：**单个反斜杠作为 RegExp 源码是非法的**
// （`new RegExp("\\")` 抛 `Invalid regular expression: /\/g`）。
// v0.5 的待办面板曾这样写，导致「全部项目」视图一旦遇到不在项目列表里的
// cwd 就抛 SyntaxError → React 整棵树卸载 → 整个窗口白屏。
// 这里直接用字符类 `[\\/]`（源码里是转义好的双反斜杠，不是运行时拼串）。

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

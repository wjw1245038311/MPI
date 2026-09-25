/**
 * 宽屏「对话区宽度」预设。
 *
 * 为什么做成设置而不是写死：4K 屏上「用满宽度」与「正文可读」本身矛盾——
 * 一行超过 ~100 字符就读不下去，而这个界面里 thinking（准正文）占大头。所以把选择权
 * 交给用户，默认取「左右对称留白」的居中档，需要时切「拉满」。
 *
 * 只影响 **≥1024px**（`styles.css` 的宽屏媒体查询）；手机端（<1024px）行为完全不变。
 * 取值经 CSS 变量注入：`--thread-col-max` / `--thread-col-margin` / `--thread-prose-max`。
 */
export type ColumnPreset = "narrow" | "standard" | "wide" | "full";

export interface ColumnPresetSpec {
  label: string;
  /** 工具条 chip 上的短文案（chip 很窄，用完整 label 会认不出来是干什么的）。 */
  chip: string;
  /** 面板里的一句话说明（把代价讲清，别让用户猜）。 */
  note: string;
  /** 对话列最大宽度（CSS max-width 值）。 */
  colMax: string;
  /** 列的水平外边距：`auto` = 居中（左右对称留白）；`0` = 贴左（拉满时无留白）。 */
  colMargin: string;
  /** 正文（.msg-text / thinking）的可读上限；`none` = 不限（拉满档）。 */
  proseMax: string;
}

export const COLUMN_PRESET_ORDER: ColumnPreset[] = ["narrow", "standard", "wide", "full"];

export const COLUMN_PRESETS: Record<ColumnPreset, ColumnPresetSpec> = {
  narrow: {
    label: "窄 · 900",
    chip: "窄",
    note: "整列固定 900px 居中。正文与代码都很短，适合只看对话、旁边还要放别的窗口。",
    colMax: "900px",
    colMargin: "auto",
    proseMax: "900px",
  },
  standard: {
    label: "标准（默认）",
    chip: "标准",
    note: "占主区 68%（900–1600px）居中，左右留白对称。正文限宽 1000，代码块吃满整列。",
    colMax: "max(900px, min(68%, 1600px))",
    colMargin: "auto",
    proseMax: "1000px",
  },
  wide: {
    label: "宽 · 85%",
    chip: "宽",
    note: "占主区 85%（1000–1900px）居中。留白更少，代码块与工具输出更宽。",
    colMax: "max(1000px, min(85%, 1900px))",
    colMargin: "auto",
    proseMax: "1100px",
  },
  full: {
    label: "拉满 · 无留白",
    chip: "拉满",
    note: "占满主区、不留白。正文也不再限宽——4K 下一行会很长（约 200 字符），只建议以代码/工具输出为主的会话。",
    colMax: "100%",
    colMargin: "0",
    proseMax: "none",
  },
};

export const DEFAULT_COLUMN_PRESET: ColumnPreset = "standard";
export const COLUMN_PRESET_STORAGE_KEY = "mpi-column-preset";

const isPreset = (value: unknown): value is ColumnPreset =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(COLUMN_PRESETS, value);

/** 读本地偏好；不可用 / 值非法一律回默认值（绝不抛）。 */
export function readColumnPreset(): ColumnPreset {
  try {
    const raw = localStorage.getItem(COLUMN_PRESET_STORAGE_KEY);
    return isPreset(raw) ? raw : DEFAULT_COLUMN_PRESET;
  } catch {
    return DEFAULT_COLUMN_PRESET; // 隐私模式 / storage 被禁用
  }
}

export function writeColumnPreset(preset: ColumnPreset): void {
  try {
    localStorage.setItem(COLUMN_PRESET_STORAGE_KEY, preset);
  } catch { /* 存不了就只用这一次，不影响使用 */ }
}

/** 注入到 `.app` 内联样式的 CSS 变量。 */
export function columnCssVars(preset: ColumnPreset): Record<string, string> {
  const spec = COLUMN_PRESETS[preset];
  return {
    "--thread-col-max": spec.colMax,
    "--thread-col-margin": spec.colMargin,
    "--thread-prose-max": spec.proseMax,
  };
}

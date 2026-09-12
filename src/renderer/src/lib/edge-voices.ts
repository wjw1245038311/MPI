/**
 * Edge TTS voice catalogue (语音系统 → 语音输出), shared by the Settings UI and
 * its L1 test.
 *
 * Edge TTS is a *free, key-less* online neural-voice engine (Microsoft's Read
 * Aloud endpoint). The catalogue below is deliberately short — the most useful
 * zh/en voices, not the full upstream list — because a giant dropdown of
 * near-duplicate voices is worse than a curated one. All names are the upstream
 * short names (e.g. "zh-CN-XiaoxiaoNeural").
 *
 * Speech-to-text is configured manually (any OpenAI-compatible
 * `/audio/transcriptions` endpoint, including a self-hosted local service); the
 * UI explains how, so this module no longer carries cloud STT presets.
 */

/** One Edge TTS neural voice. */
export interface EdgeVoice {
  /** Upstream short name, e.g. "zh-CN-XiaoxiaoNeural". */
  shortName: string;
  /** BCP-47 language tag, e.g. "zh-CN". */
  lang: string;
  zh: string;
  en: string;
}

/**
 * Curated Edge TTS voices: enough variety (mainland Mandarin, Taiwan, HK,
 * US/UK English; female + male) without drowning the user. Order = display
 * order, grouped by language.
 */
export const EDGE_VOICES: readonly EdgeVoice[] = [
  { shortName: "zh-CN-XiaoxiaoNeural", lang: "zh-CN", zh: "晓晓（女·普通话）", en: "Xiaoxiao (F, Mandarin)" },
  { shortName: "zh-CN-XiaoyiNeural", lang: "zh-CN", zh: "晓伊（女·普通话）", en: "Xiaoyi (F, Mandarin)" },
  { shortName: "zh-CN-YunxiNeural", lang: "zh-CN", zh: "云希（男·普通话）", en: "Yunxi (M, Mandarin)" },
  { shortName: "zh-CN-YunyangNeural", lang: "zh-CN", zh: "云扬（男·新闻）", en: "Yunyang (M, news)" },
  { shortName: "zh-CN-YunxiaNeural", lang: "zh-CN", zh: "云夏（男·少年）", en: "Yunxia (M, youth)" },
  { shortName: "zh-TW-HsiaoChenNeural", lang: "zh-TW", zh: "曉臻（女·台湾）", en: "HsiaoChen (F, Taiwan)" },
  { shortName: "zh-HK-HiuMaanNeural", lang: "zh-HK", zh: "曉曼（女·粤语）", en: "HiuMaan (F, Cantonese)" },
  { shortName: "en-US-AriaNeural", lang: "en-US", zh: "Aria（女·美音）", en: "Aria (F, US)" },
  { shortName: "en-US-JennyNeural", lang: "en-US", zh: "Jenny（女·美音）", en: "Jenny (F, US)" },
  { shortName: "en-US-GuyNeural", lang: "en-US", zh: "Guy（男·美音）", en: "Guy (M, US)" },
  { shortName: "en-US-DavisNeural", lang: "en-US", zh: "Davis（男·美音）", en: "Davis (M, US)" },
  { shortName: "en-GB-SoniaNeural", lang: "en-GB", zh: "Sonia（女·英音）", en: "Sonia (F, UK)" },
  { shortName: "en-GB-RyanNeural", lang: "en-GB", zh: "Ryan（男·英音）", en: "Ryan (M, UK)" },
];

/** Default Edge voice for the UI language (zh → Xiaoxiao, en → Aria). */
export function defaultEdgeVoice(lang: "zh" | "en"): string {
  return lang === "zh" ? "zh-CN-XiaoxiaoNeural" : "en-US-AriaNeural";
}

/** Look up a catalogued Edge voice by short name. */
export function findEdgeVoice(shortName: string | undefined): EdgeVoice | undefined {
  if (!shortName) return undefined;
  return EDGE_VOICES.find((v) => v.shortName === shortName);
}

/**
 * Convert the UI rate multiplier (0.5–2, 1 = normal) into the Edge TTS rate
 * string ("-50%" … "+100%"). Values are clamped to Edge's accepted range so a
 * hand-edited config can't produce an out-of-range SSML attribute.
 */
export function edgeRatePercent(rate: number | undefined): string {
  const r = typeof rate === "number" && Number.isFinite(rate) ? rate : 1;
  const pct = Math.round(Math.min(2, Math.max(0.5, r)) * 100 - 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

/**
 * Voice system — text-to-speech (TTS) side, running entirely in the renderer on
 * top of the Web Speech API (`speechSynthesis`). On Windows this uses the OS's
 * installed SAPI voices (Chinese voices work when a zh language pack is
 * present), fully offline with no extra dependencies.
 *
 * Design notes:
 * - Long agent replies are split into sentence-sized chunks and spoken ONE AT A
 *   TIME via an onend chain. Batching many utterances in one speak() call hits
 *   Chromium's "queue silently stops" bug, so we never do that.
 * - Markdown is stripped before speaking (fenced code becomes a single
 *   "(code block)" marker) — reading raw diffs aloud is noise.
 * - A generation token cancels stale chains: stopTts() or a new speakMessage()
 *   invalidates any in-flight chunk loop immediately.
 *
 * The pure helpers (cleanForSpeech / chunkText) are exported for the strip-types
 * test runner; all DOM access happens inside functions, never at module scope.
 */

export interface TtsState {
  status: "idle" | "speaking";
  /** Message id currently being spoken (see speakMessage). */
  messageId?: string;
}

let state: TtsState = { status: "idle" };
const listeners = new Set<() => void>();

function setState(next: TtsState): void {
  if (state.status === next.status && state.messageId === next.messageId) return;
  state = next;
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      // A throwing subscriber must not break the TTS loop.
    }
  }
}

/** useSyncExternalStore-compatible subscription to the playback state. */
export function subscribeTts(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getTtsState(): TtsState {
  return state;
}

/* ------------------------------------------------------------------ *
 * Pure text preparation (unit-tested in scripts/test-voice.mjs)
 * ------------------------------------------------------------------ */

/**
 * Strip markdown down to speakable prose. Fenced code blocks collapse to a
 * single marker, links keep their label, tables flatten to comma-separated
 * cells, and everything else degrades to its visible text.
 */
export function cleanForSpeech(raw: string, zh: boolean): string {
  let t = raw || "";
  // Fenced code blocks → one spoken marker each (``` without a closing fence
  // — e.g. a still-streaming message — is dropped entirely).
  t = t.replace(/```[\s\S]*?```/g, zh ? "（代码块）" : "(code block)");
  t = t.replace(/```[\s\S]*$/g, "");
  // Inline code: keep the content, drop the backticks.
  t = t.replace(/`([^`\n]+)`/g, "$1");
  // Images → alt text (usually empty); links → label; bare URLs dropped.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, " $1 ");
  t = t.replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1");
  t = t.replace(/https?:\/\/\S+/g, " ");
  // HTML tags (preview references etc.).
  t = t.replace(/<[^>\n]+>/g, " ");
  // Table separator rows (|---|:--:|) vanish; pipes become commas.
  const lines = t.split("\n").map((line) => (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) ? "" : line));
  t = lines.join("\n").replace(/\|/g, ", ");
  // Headings / emphasis / strikethrough / quotes / list markers.
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/(\*\*|__)([\s\S]*?)\1/g, "$2");
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1$2");
  t = t.replace(/~~([^~\n]+)~~/g, "$1");
  t = t.replace(/^>\s?/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*\d+[.)]\s+/gm, "");
  // Collapse whitespace; keep paragraph breaks as pauses.
  t = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/** Sentence-end punctuation that ends a spoken chunk (CJK + latin). */
const SENTENCE_END = /[。！？!?；;\n]/;

/**
 * Split text into chunks of at most `maxLen` characters, preferring sentence
 * boundaries. A single unbroken run longer than maxLen is hard-split — TTS
 * engines truncate over-long utterances, so the cap matters more than elegance.
 */
export function chunkText(text: string, maxLen = 200): string[] {
  const source = (text || "").trim();
  if (!source) return [];
  if (maxLen < 16) throw new Error("chunkText: maxLen too small");

  // Split keeping the delimiter attached to the preceding piece.
  const pieces: string[] = [];
  let current = "";
  for (const ch of source) {
    current += ch;
    if (SENTENCE_END.test(ch)) {
      pieces.push(current);
      current = "";
    }
  }
  if (current) pieces.push(current);

  const chunks: string[] = [];
  let buf = "";
  for (const piece of pieces) {
    // Hard-split pathological pieces first.
    const parts = piece.length <= maxLen ? [piece] : Array.from({ length: Math.ceil(piece.length / maxLen) }, (_, i) => piece.slice(i * maxLen, (i + 1) * maxLen));
    for (const part of parts) {
      if (!buf) {
        buf = part;
      } else if ((buf + part).length <= maxLen) {
        buf += part;
      } else {
        chunks.push(buf.trim());
        buf = part;
      }
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Playback controller
 * ------------------------------------------------------------------ */

let generation = 0;
let cachedVoices: SpeechSynthesisVoice[] | null = null;

function synth(): SpeechSynthesis | null {
  try {
    return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  } catch {
    return null;
  }
}

/** All voices known to the platform (cached; refreshed on voiceschanged). */
export function ttsVoices(): SpeechSynthesisVoice[] {
  const s = synth();
  if (!s) return [];
  if (!cachedVoices || cachedVoices.length === 0) {
    try {
      cachedVoices = s.getVoices() || [];
    } catch {
      cachedVoices = [];
    }
    // Voices often arrive asynchronously on the first call.
    try {
      s.addEventListener?.("voiceschanged", () => {
        cachedVoices = null;
      });
    } catch {
      // Older engines: getVoices() polling by callers is enough.
    }
  }
  return cachedVoices || [];
}

/** Pick a sensible default voice for the UI language (zh → zh, en → en). */
export function pickDefaultVoice(lang: "zh" | "en"): SpeechSynthesisVoice | null {
  const voices = ttsVoices();
  if (!voices.length) return null;
  const prefix = lang === "zh" ? "zh" : "en";
  // Exact language first, then any voice sharing the family (e.g. en-AU for en).
  const exact = voices.find((v) => v.lang?.toLowerCase().startsWith(prefix));
  return exact || voices[0];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let edgeFallbackWarned = false;
/** Last upstream Edge failure reason (surfaced via SpeakResult.detail). */
let edgeLastError: string | null = null;
let currentAudio: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;

export interface SpeakOptions {
  /** Explicit system voice URI (Settings); absent = auto-pick by `lang`. */
  voiceUri?: string;
  /** Rate multiplier 0.5–2; absent = 1. */
  rate?: number;
  lang?: "zh" | "en";
  /** Playback engine; absent = "system" (offline speechSynthesis). */
  backend?: "system" | "edge";
  /** Edge voice short name; absent = auto-pick by `lang`. */
  edgeVoice?: string;
}

export interface SpeakResult {
  ok: boolean;
  error?: "unsupported" | "no-voice" | "empty-text";
  /** True when the requested Edge engine failed and system TTS took over
   * (reported at most once per session). */
  fallback?: boolean;
  /** Upstream detail of the Edge failure (i18n key or short error string),
   * surfaced in the fallback toast so users can report what actually broke. */
  detail?: string;
}

/**
 * Speak a message aloud, replacing whatever is currently playing. Resolves once
 * the FIRST chunk has started (or failed) — the rest of the chain continues in
 * the background and reports progress through subscribeTts().
 */
export async function speakMessage(messageId: string, rawText: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  const lang = opts.lang || "en";
  const text = cleanForSpeech(rawText, lang === "zh");
  const chunks = chunkText(text);
  if (!chunks.length) return { ok: false, error: "empty-text" };

  // Edge engine: free online neural voices. On any pre-playback failure we fall
  // through to the offline system engine (and say so once).
  if (opts.backend === "edge" && typeof window !== "undefined" && typeof window.pi?.voice?.synthesize === "function") {
    const edge = await speakEdge(messageId, chunks, opts);
    if (edge) return edge;
    const sys = await speakSystem(messageId, chunks, opts);
    const fallback = !edgeFallbackWarned;
    edgeFallbackWarned = true;
    const detail = edgeLastError || undefined;
    edgeLastError = null;
    return fallback ? { ...sys, fallback: true, detail } : sys;
  }

  return speakSystem(messageId, chunks, opts);
}

/** Stop playback immediately and reset state. Safe to call when idle. */
export function stopTts(): void {
  generation++;
  stopEdgeAudio();
  try {
    synth()?.cancel();
  } catch {
    // ignore
  }
  setState({ status: "idle" });
}

/** Cancel any in-flight Edge <audio> and release its blob URL. */
function stopEdgeAudio(): void {
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      // ignore
    }
    currentAudio = null;
  }
  if (currentObjectUrl) {
    try {
      URL.revokeObjectURL(currentObjectUrl);
    } catch {
      // ignore
    }
    currentObjectUrl = null;
  }
}

/** base64 → bytes (the renderer has atob). */
function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

/**
 * Play one synthesized MP3. Resolves true when it finished, false on error.
 * A newer generation (stop / new speak) pauses the element immediately.
 */
function playBase64Audio(base64: string, mime: string, myGen: number): Promise<boolean> {
  return new Promise((resolve) => {
    let url: string;
    let audio: HTMLAudioElement;
    try {
      url = URL.createObjectURL(new Blob([base64ToBytes(base64)], { type: mime || "audio/mpeg" }));
      audio = new Audio(url);
      audio.preload = "auto";
    } catch {
      resolve(false);
      return;
    }
    currentAudio = audio;
    currentObjectUrl = url;
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (currentAudio === audio) currentAudio = null;
      if (currentObjectUrl === url) currentObjectUrl = null;
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
      resolve(ok);
    };
    audio.onended = () => done(true);
    audio.onerror = () => done(false);
    if (myGen !== generation) {
      done(false);
      return;
    }
    audio.play().catch(() => done(false));
  });
}

/**
 * Edge playback loop. Returns null when nothing was played and the caller should
 * fall back to the system engine; otherwise the in-flight result.
 */
async function speakEdge(messageId: string, chunks: string[], opts: SpeakOptions): Promise<SpeakResult | null> {
  const myGen = ++generation;
  stopEdgeAudio();
  setState({ status: "speaking", messageId });

  for (let i = 0; i < chunks.length; i++) {
    if (myGen !== generation) return { ok: true };
    let res: Awaited<ReturnType<typeof window.pi.voice.synthesize>> | null = null;
    try {
      res = await window.pi.voice.synthesize({ text: chunks[i], voice: opts.edgeVoice, rate: opts.rate });
    } catch (e) {
      res = null;
      edgeLastError = `ipc:${String((e as Error)?.message || e).slice(0, 120)}`;
    }
    if (myGen !== generation) return { ok: true };
    const base64 = res?.ok ? res.audioBase64 : undefined;
    if (!base64) {
      edgeLastError = typeof res?.error === "string" && res.error ? res.error.slice(0, 120) : "no-audio";
      setState({ status: "idle" });
      // Nothing heard yet → let the caller fall back; otherwise stop cleanly.
      return i === 0 ? null : { ok: true };
    }
    const played = await playBase64Audio(base64, res?.mime || "audio/mpeg", myGen);
    if (myGen !== generation) return { ok: true };
    if (!played) {
      edgeLastError = "playback-failed";
      setState({ status: "idle" });
      return i === 0 ? null : { ok: true };
    }
  }
  if (myGen === generation) setState({ status: "idle" });
  return { ok: true };
}

/** Offline engine: the original speechSynthesis chunk chain. */
async function speakSystem(messageId: string, chunks: string[], opts: SpeakOptions): Promise<SpeakResult> {
  const s = synth();
  if (!s) return { ok: false, error: "unsupported" };

  let voice: SpeechSynthesisVoice | null = null;
  if (opts.voiceUri) {
    voice = ttsVoices().find((v) => v.voiceURI === opts.voiceUri || v.name === opts.voiceUri) || null;
  }
  if (!voice) voice = pickDefaultVoice(opts.lang || "en");

  const myGen = ++generation;
  s.cancel();
  // Chromium quirk: speaking immediately after cancel() can be swallowed.
  await delay(80);
  if (myGen !== generation) return { ok: false, error: "empty-text" };

  setState({ status: "speaking", messageId });

  const rate = Math.min(2, Math.max(0.5, opts.rate || 1));
  let started = false;
  for (let i = 0; i < chunks.length; i++) {
    if (myGen !== generation) return { ok: true }; // stopped mid-chain
    const result = await speakChunk(s, chunks[i], voice, rate);
    if (!started) {
      started = true;
      if (result === "error") {
        setState({ status: "idle" });
        return { ok: false, error: "no-voice" };
      }
    }
  }
  if (myGen === generation) setState({ status: "idle" });
  return { ok: true };
}

function speakChunk(
  s: SpeechSynthesis,
  text: string,
  voice: SpeechSynthesisVoice | null,
  rate: number,
): Promise<"ok" | "error"> {
  return new Promise((resolve) => {
    let utterance: SpeechSynthesisUtterance;
    try {
      utterance = new SpeechSynthesisUtterance(text);
    } catch {
      resolve("error");
      return;
    }
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = rate;
    let settled = false;
    const finish = (result: "ok" | "error") => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    utterance.onend = () => finish("ok");
    utterance.onerror = (e) => finish(e?.error === "canceled" || e?.error === "interrupted" ? "ok" : "error");
    try {
      s.speak(utterance);
    } catch {
      finish("error");
    }
  });
}

/**
 * Voice system — speech-to-text (STT) side, running in the main process so API
 * keys never need to round-trip through IPC payloads.
 *
 * The renderer records microphone audio (MediaRecorder), converts it to a small
 * 16 kHz mono WAV and hands us base64. We transcribe it with one of two
 * backends, both configured in Settings → General → 语音系统:
 *
 * - "openai": any OpenAI-compatible /v1/audio/transcriptions endpoint (OpenAI
 *   itself or compatible gateways). Multipart upload; model defaults whisper-1.
 * - "gemini": Gemini generateContent with the audio as inline base64 data — a
 *   single JSON request, no multipart. Only the API key is taken from the
 *   referenced provider (the endpoint is Google's fixed one unless overridden).
 *
 * Credentials resolution: an explicit manual key wins; otherwise the provider
 * referenced by sttProviderId is read LIVE from ~/.pi/agent/models.json at call
 * time, so rotating a key in Settings keeps working without re-saving voice.
 *
 * Kept dependency-free (type-only imports) so the strip-types test runner can
 * import it directly; `fetch` is injectable for tests.
 */
import { STT_PROVIDER_MANUAL } from "./config";
import type { SttBackend, VoiceConfig } from "./config";

/** Minimal provider shape we care about (mirrors ProviderDef). */
export interface SttProviderRef {
  baseUrl?: string;
  apiKey?: string;
}

export interface ResolvedStt {
  backend: SttBackend;
  /** OpenAI-compatible root, e.g. https://api.openai.com/v1 (no trailing slash). */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Default models per backend when the user left sttModel empty. */
export const STT_DEFAULT_MODELS: Record<SttBackend, string> = {
  openai: "whisper-1",
  gemini: "gemini-2.5-flash",
};

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

/** Hard cap for one transcription payload (base64 chars). ~9 MB of WAV ≈ 3 min
 * at 16 kHz mono — recordings are capped earlier in the renderer anyway. */
export const STT_MAX_B64_CHARS = 12_000_000;

const TRANSCRIBE_TIMEOUT_MS = 120_000;

/**
 * Resolve backend + endpoint + key + model from the persisted voice config and
 * the live models.json providers. Throws an Error with a short, displayable
 * message when the configuration is incomplete or inconsistent.
 */
export function resolveStt(
  cfg: VoiceConfig | undefined,
  providers: Record<string, SttProviderRef>,
): ResolvedStt {
  const backend = cfg?.sttBackend;
  if (backend !== "openai" && backend !== "gemini") {
    throw new Error("voice.stt.not-configured");
  }
  const providerId = cfg?.sttProviderId;
  const manual = !providerId || providerId === STT_PROVIDER_MANUAL;
  const provider = manual ? undefined : providers[providerId];
  if (!manual && !provider) {
    throw new Error(`voice.stt.provider-missing:${providerId}`);
  }

  const apiKey = (cfg?.sttApiKey || "").trim() || provider?.apiKey?.trim() || "";
  if (!apiKey) {
    throw new Error("voice.stt.no-key");
  }

  const model = (cfg?.sttModel || "").trim() || STT_DEFAULT_MODELS[backend];

  let baseUrl: string;
  if (backend === "gemini") {
    // Google's endpoint is fixed unless the user explicitly pointed at a proxy.
    baseUrl = ((cfg?.sttBaseUrl || provider?.baseUrl || GEMINI_BASE_URL).trim() || GEMINI_BASE_URL)
      .replace(/\/+$/, "");
  } else {
    const raw = (cfg?.sttBaseUrl || provider?.baseUrl || "").trim();
    if (!raw) throw new Error("voice.stt.no-base-url");
    baseUrl = raw.replace(/\/+$/, "");
  }

  return { backend, baseUrl, apiKey, model };
}

/** OpenAI-compatible multipart request descriptor (assembled by the caller). */
export interface OpenAiSttRequest {
  url: string;
  headers: Record<string, string>;
  fields: Record<string, string>;
  file: { name: string; type: string; base64: string };
}

/** Build the /audio/transcriptions request for a WAV payload. */
export function buildOpenAiRequest(resolved: ResolvedStt, wavBase64: string): OpenAiSttRequest {
  return {
    url: `${resolved.baseUrl}/audio/transcriptions`,
    headers: { Authorization: `Bearer ${resolved.apiKey}` },
    fields: { model: resolved.model },
    file: { name: "recording.wav", type: "audio/wav", base64: wavBase64 },
  };
}

/** Gemini generateContent request descriptor (plain JSON body). */
export interface GeminiSttRequest {
  url: string;
  headers: Record<string, string>;
  bodyJson: unknown;
}

const GEMINI_TRANSCRIBE_PROMPT = [
  "Transcribe this audio verbatim. Output ONLY the spoken text in its original",
  "language — no translation, no commentary, no quotes. If there is no speech,",
  "output a single hyphen.",
].join(" ");

/** Build the Gemini inline-audio request for a WAV payload. */
export function buildGeminiRequest(resolved: ResolvedStt, wavBase64: string): GeminiSttRequest {
  return {
    url: `${resolved.baseUrl}/v1beta/models/${encodeURIComponent(resolved.model)}:generateContent`,
    headers: { Authorization: `Bearer ${resolved.apiKey}`, "Content-Type": "application/json" },
    bodyJson: {
      contents: [
        {
          parts: [
            { inline_data: { mime_type: "audio/wav", data: wavBase64 } },
            { text: GEMINI_TRANSCRIBE_PROMPT },
          ],
        },
      ],
    },
  };
}

/** Extract the transcript from a Gemini generateContent response. */
export function parseGeminiTranscript(json: any): string {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

export interface TranscribeResult {
  ok: boolean;
  /** Recognized text; empty string when the audio contained no speech. */
  text?: string;
  error?: string;
}

type FetchLike = (url: string, init?: any) => Promise<any>;

interface SttDeps {
  cfg?: VoiceConfig;
  providers?: Record<string, SttProviderRef>;
  fetchImpl?: FetchLike;
}

async function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work();
  } finally {
    clearTimeout(timer);
  }
}

function httpErrorDetail(status: number, bodyText: string): string {
  // Keep the first line of the API's error message (usually JSON with "error").
  let detail = "";
  try {
    const parsed = JSON.parse(bodyText);
    detail =
      typeof parsed?.message === "string"
        ? parsed.message
        : typeof parsed?.error?.message === "string"
          ? parsed.error.message
          : bodyText.slice(0, 200);
  } catch {
    detail = bodyText.slice(0, 200);
  }
  return `HTTP ${status} ${detail}`.trim();
}

/**
 * Transcribe a base64 WAV recording with the configured backend.
 * `deps` overrides exist for tests and for callers that already hold config.
 */
export async function transcribeAudio(
  args: { dataBase64?: string },
  deps: SttDeps = {},
): Promise<TranscribeResult> {
  const fetchImpl: FetchLike = deps.fetchImpl || ((...a) => fetch(...a));
  let resolved: ResolvedStt;
  try {
    resolved = resolveStt(deps.cfg, deps.providers || {});
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }

  const b64 = String(args?.dataBase64 || "").replace(/\s/g, "");
  if (!b64) return { ok: false, error: "voice.stt.empty-audio" };
  if (b64.length > STT_MAX_B64_CHARS) return { ok: false, error: "voice.stt.too-large" };

  try {
    let response: any;
    if (resolved.backend === "openai") {
      const req = buildOpenAiRequest(resolved, b64);
      const form = new FormData();
      for (const [key, value] of Object.entries(req.fields)) form.append(key, value);
      form.append("file", new Blob([Buffer.from(req.file.base64, "base64")], { type: req.file.type }), req.file.name);
      response = await withTimeout(
        () => fetchImpl(req.url, { method: "POST", headers: req.headers, body: form }),
        TRANSCRIBE_TIMEOUT_MS,
      );
    } else {
      const req = buildGeminiRequest(resolved, b64);
      response = await withTimeout(
        () =>
          fetchImpl(req.url, {
            method: "POST",
            headers: req.headers,
            body: JSON.stringify(req.bodyJson),
          }),
        TRANSCRIBE_TIMEOUT_MS,
      );
    }

    const bodyText = typeof response?.text === "function" ? await response.text() : String(response ?? "");
    if (!response?.ok) {
      return { ok: false, error: httpErrorDetail(Number(response?.status || 0), bodyText) };
    }

    let text = "";
    try {
      const json = JSON.parse(bodyText);
      text = resolved.backend === "gemini" ? parseGeminiTranscript(json) : String(json?.text ?? "").trim();
    } catch {
      return { ok: false, error: `voice.stt.bad-response:${bodyText.slice(0, 120)}` };
    }
    // Gemini answers "-" (or similar) for silence; normalize to empty.
    if (/^[-—–\s]*$/.test(text)) text = "";
    return { ok: true, text };
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    return { ok: false, error: aborted ? "voice.stt.timeout" : String(e?.message || e) };
  }
}

/**
 * Connectivity probe for the Settings test button: transcribes a short silent
 * WAV. Success means endpoint + key + model are all valid (text comes back
 * empty); failures surface the API's error message.
 */
export async function testStt(deps: SttDeps = {}): Promise<TranscribeResult> {
  const wavBase64 = makeSilentWavBase64(0.5, 16_000);
  return transcribeAudio({ dataBase64: wavBase64 }, deps);
}

/** Encode `seconds` of silence as a 16-bit PCM mono WAV (RIFF) in base64. */
export function makeSilentWavBase64(seconds: number, sampleRate = 16_000): string {
  const numSamples = Math.max(1, Math.floor(seconds * sampleRate));
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer.toString("base64");
}

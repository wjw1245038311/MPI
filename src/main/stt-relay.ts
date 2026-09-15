/**
 * Phone voice memo → local STT relay (pure core, no electron imports so the
 * strip-types test runner can import it directly — mirrors voice.ts conventions).
 *
 * One STT setup serves both clients: the phone's stt.transcribe frame goes to
 * the SAME OpenAI-compatible endpoint the desktop composer mic uses (the
 * `voice` config, typically written by the local-voice app-store component →
 * http://127.0.0.1:8800/v1 · SenseVoiceSmall). If that target is down (app
 * disabled), we fall back to the voice-stack gateway's raw-WAV endpoint on
 * 127.0.0.1:8093, so phone voice keeps working across service outages.
 */

export interface SttVoiceConfig {
  sttBackend?: string;
  sttBaseUrl?: string;
  sttModel?: string;
  sttApiKey?: string;
}

export interface SttRelayConfig {
  /** The desktop voice config (Settings → Conversation → 语音系统). */
  voice?: SttVoiceConfig;
  /** Explicit override: OpenAI-compatible /v1 base URL for phone STT. */
  sttUrl?: string;
}

export interface OpenAiSttTarget {
  kind: "openai";
  baseUrl: string; // "/v1" root — we POST to <baseUrl>/audio/transcriptions
  model: string;
  apiKey?: string;
}

/** local-voice app-store component default (bundled SenseVoiceSmall server). */
export const DEFAULT_LOCAL_VOICE_URL = "http://127.0.0.1:8800/v1";
/** voice-stack gateway raw-WAV endpoint (last-resort fallback). */
export const GATEWAY_STT_URL = "http://127.0.0.1:8093/v1/audio/transcriptions";

const DEFAULT_MODEL = "SenseVoiceSmall";

/** Ordered STT targets for phone voice memos (primary first). */
export function resolveSttTargets(cfg: SttRelayConfig): OpenAiSttTarget[] {
  const targets: OpenAiSttTarget[] = [];
  if (cfg.voice?.sttBackend === "openai" && cfg.voice.sttBaseUrl) {
    // Same endpoint the desktop mic uses — one config, two clients.
    targets.push({
      kind: "openai",
      baseUrl: cfg.voice.sttBaseUrl.replace(/\/+$/, ""),
      model: cfg.voice.sttModel || DEFAULT_MODEL,
      apiKey: cfg.voice.sttApiKey,
    });
  } else if (cfg.sttUrl) {
    targets.push({ kind: "openai", baseUrl: cfg.sttUrl.replace(/\/+$/, ""), model: DEFAULT_MODEL });
  } else {
    targets.push({ kind: "openai", baseUrl: DEFAULT_LOCAL_VOICE_URL, model: DEFAULT_MODEL });
  }
  return targets;
}

export interface SttResult {
  text: string;
  /** Which target produced the text (for logs / diagnostics). */
  via: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** POST a WAV to an OpenAI-compatible /audio/transcriptions endpoint (multipart). */
export async function transcribeViaOpenAi(
  target: OpenAiSttTarget,
  wav: Buffer,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): Promise<SttResult> {
  const form = new FormData();
  form.append("model", target.model);
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
  const headers: Record<string, string> = {};
  if (target.apiKey) headers["authorization"] = `Bearer ${target.apiKey}`;
  let res: Response;
  try {
    res = await fetchImpl(`${target.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers, // no content-type — fetch sets the multipart boundary itself
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`unreachable (${target.baseUrl}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`http ${res.status} from ${target.baseUrl}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { text?: string };
  return { text: typeof data.text === "string" ? data.text : "", via: `openai:${target.baseUrl}` };
}

/** POST raw WAV bytes to the voice-stack gateway endpoint (its native protocol). */
export async function transcribeViaGateway(
  wav: Buffer,
  url: string = GATEWAY_STT_URL,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): Promise<SttResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`unreachable (${url}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`http ${res.status} from gateway: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { text?: string };
  return { text: typeof data.text === "string" ? data.text : "", via: `gateway:${url}` };
}

/**
 * Transcribe a phone voice memo, trying targets in order and falling back to
 * the gateway's raw-WAV endpoint. Throws with all failure reasons if nothing
 * works (the PWA surfaces this as an error toast).
 */
export async function transcribeWav(
  wavB64: string,
  cfg: SttRelayConfig,
  fetchImpl?: FetchLike,
): Promise<SttResult> {
  const wav = Buffer.from(wavB64, "base64");
  if (!wav.length) throw new Error("empty audio payload");
  const errors: string[] = [];
  for (const target of resolveSttTargets(cfg)) {
    try {
      return await transcribeViaOpenAi(target, wav, fetchImpl);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    return await transcribeViaGateway(wav, GATEWAY_STT_URL, fetchImpl);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  throw new Error(`all STT targets failed: ${errors.join(" | ")}`);
}

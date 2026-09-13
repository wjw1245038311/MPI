/**
 * Voice system — recording side. Captures microphone audio with MediaRecorder,
 * then converts it to a 16 kHz mono WAV before transcription: both STT backends
 * accept WAV natively (Gemini's inline-audio API does NOT list webm/opus, which
 * is what Chromium's MediaRecorder produces by default).
 *
 * The conversion pipeline: blob → decodeAudioData → OfflineAudioContext resample
 * to 16 kHz mono → 16-bit PCM WAV. A 3-minute clip ends up ≈ 5.8 MB (≈ 7.7 MB
 * base64), well within IPC and API limits; the composer caps recordings at 3 min.
 */

export type SttErrorCode = "mic-denied" | "no-mic" | "record-failed" | "empty-recording" | "decode-failed";

export class SttError extends Error {
  code: SttErrorCode;
  constructor(code: SttErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Localize a recording error code (renderer-side failures). */
export function sttRecordErrorText(code: SttErrorCode, zh: boolean): string {
  switch (code) {
    case "mic-denied":
      return zh ? "麦克风访问被拒绝，请在系统设置中允许 MPI 使用麦克风" : "Microphone access was denied — allow MPI to use the microphone in system settings";
    case "no-mic":
      return zh ? "未找到可用的麦克风设备" : "No usable microphone device found";
    case "empty-recording":
      return zh ? "未录到声音（录音太短或麦克风无声），请重试" : "No audio captured (too short or silent) — please try again";
    case "decode-failed":
      return zh ? "录音解码失败，请重试" : "Could not decode the recording — please try again";
    default:
      return zh ? "无法启动录音" : "Could not start recording";
  }
}

/** Localize a transcription error coming from main (voice.stt.* keys or API detail). */
export function sttTranscribeErrorText(error: string, zh: boolean): string {
  if (!error) return zh ? "识别失败，请重试" : "Transcription failed — please retry";
  switch (error) {
    case "voice.stt.not-configured":
      return zh
        ? "语音输入未配置：请先在 设置 → 对话设置 → 语音系统 中选择识别服务"
        : "Voice input is not configured: pick a transcription service in Settings → Conversation → Voice";
    case "voice.stt.no-key":
      return zh ? "缺少 API key，请在 设置 → 对话设置 → 语音系统 中检查配置" : "Missing API key — check Settings → Conversation → Voice";
    case "voice.stt.no-base-url":
      return zh
        ? "缺少服务地址（OpenAI 兼容端点需要 Base URL），请检查 设置 → 对话设置 → 语音系统"
        : "Missing base URL (the OpenAI-compatible backend needs one) — check Settings → Conversation → Voice";
    case "voice.stt.app-bundled":
      return zh
        ? "「服务地址」留空 = 使用应用自带的内置服务：启用应用后会自动启动，无需在此测试。若你填了外部 STT 地址，再点测试。"
        : "Blank endpoint = use the app's bundled service: it starts automatically when you enable the app, so there is nothing to test here. Fill in an external STT URL first if you want to probe one.";
    case "voice.stt.too-large":
      return zh ? "录音过长，无法识别（上限约 3 分钟）" : "Recording too long to transcribe (~3 minute cap)";
    case "voice.stt.timeout":
      return zh ? "识别超时，请检查网络后重试" : "Transcription timed out — check your network and retry";
    default: {
      const providerMissing = error.match(/^voice\.stt\.provider-missing:(.+)$/);
      if (providerMissing) {
        return zh
          ? `引用的提供商「${providerMissing[1]}」不存在，请在 设置 → 对话设置 → 语音系统 中重新选择`
          : `Referenced provider “${providerMissing[1]}” no longer exists — re-pick it in Settings → Conversation → Voice`;
      }
      if (error.startsWith("voice.stt.bad-response:")) {
        return zh ? `识别服务返回了无法解析的内容：${error.slice(24).slice(0, 80)}` : `Unparseable response from the transcription service: ${error.slice(24).slice(0, 80)}`;
      }
      // API-level detail (HTTP status + message) — show it verbatim.
      return zh ? `识别失败：${error}` : `Transcription failed: ${error}`;
    }
  }
}

export interface RecordedAudio {
  /** Base64-encoded 16 kHz mono WAV. */
  base64: string;
  seconds: number;
}

export interface RecordingHandle {
  /** Stop and return the recorded audio (idempotent). */
  stop(): Promise<RecordedAudio>;
  /** Abort without returning audio (e.g. user pressed Esc / switched thread). */
  cancel(): void;
}

const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of PREFERRED_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // keep looking
    }
  }
  return "";
}

/** Start capturing the microphone. Throws SttError with a displayable code. */
export async function startRecording(): Promise<RecordingHandle> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new SttError("record-failed");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  } catch (e: any) {
    const name = e?.name || "";
    if (name === "NotAllowedError" || name === "SecurityError") throw new SttError("mic-denied");
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new SttError("no-mic");
    throw new SttError("record-failed");
  }

  const mimeType = pickMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    throw new SttError("record-failed");
  }

  const chunks: BlobPart[] = [];
  let cancelled = false;
  let stopped = false;
  const startedAt = Date.now();

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const teardown = () => stream.getTracks().forEach((track) => track.stop());

  const stoppedPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      teardown();
      // Resolve (empty blob when cancelled) so no await can ever dangle.
      resolve(new Blob(cancelled ? [] : chunks, { type: mimeType || "audio/webm" }));
    };
    recorder.onerror = () => {
      teardown();
      reject(new SttError("record-failed"));
    };
  });

  try {
    recorder.start(250); // timeslice keeps chunks flowing even if stop lags
  } catch {
    teardown();
    throw new SttError("record-failed");
  }

  let blobPromise: Promise<Blob> | null = null;
  const getBlob = () => (blobPromise ||= stoppedPromise);

  return {
    async stop() {
      if (stopped) {
        // Already stopping/stopped — wait for the same result.
        const blob = await getBlob();
        return toWavBase64(blob, startedAt);
      }
      stopped = true;
      try {
        recorder.stop();
      } catch {
        teardown();
      }
      const blob = await getBlob();
      // No audio captured (e.g. a tap shorter than one timeslice).
      if (blob.size === 0) throw new SttError("empty-recording");
      return toWavBase64(blob, startedAt);
    },
    cancel() {
      cancelled = true;
      stopped = true;
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
      teardown();
    },
  };
}

async function toWavBase64(blob: Blob, startedAt: number): Promise<RecordedAudio> {
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  try {
    return { base64: await blobToWavBase64(blob), seconds };
  } catch (e) {
    if (e instanceof SttError) throw e;
    throw new SttError("decode-failed");
  }
}

/** Decode any browser-recorded audio and re-encode as 16 kHz mono WAV base64. */
async function blobToWavBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx: typeof AudioContext | undefined =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) throw new SttError("decode-failed");

  let decoded: AudioBuffer;
  const probe = new AudioCtx();
  try {
    decoded = await probe.decodeAudioData(arrayBuffer);
  } catch {
    throw new SttError("decode-failed");
  } finally {
    void probe.close().catch(() => {});
  }

  // Resample to 16 kHz mono — the rate every STT backend handles best.
  const targetRate = 16_000;
  const length = Math.max(targetRate, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, length, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();

  return encodeWavBase64(rendered);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Encode an AudioBuffer as a 16-bit PCM mono WAV file (base64). */
export function encodeWavBase64(buffer: AudioBuffer): string {
  const numSamples = buffer.length;
  const dataSize = numSamples * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channel = buffer.getChannelData(0);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, channel[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  // Chunked btoa (a single huge string would blow the call stack).
  const bytes = new Uint8Array(out);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    for (const byte of slice) binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

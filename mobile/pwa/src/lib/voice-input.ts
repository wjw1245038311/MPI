/**
 * Voice input for the composer (T5).
 *
 * Records microphone audio and encodes a 16 kHz mono PCM16 WAV entirely in the
 * browser, so the host can forward raw bytes to the voice-stack gateway's
 * /v1/audio/transcriptions endpoint without any codec dependency.
 *
 * Uses ScriptProcessorNode (deprecated but universally available, including
 * Android WebView) instead of AudioWorklet — no extra module file to serve.
 */

export const VOICE_SAMPLE_RATE = 16000;
/** Hard cap: ~2 minutes of 16k mono PCM16 ≈ 3.8 MB raw / ~5.1 MB base64. */
const MAX_SECONDS = 120;

function floatToPcm16(floats: Float32Array): Int16Array {
  const out = new Int16Array(floats.length);
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Encode PCM16 samples as a canonical RIFF/WAVE file (44-byte header). */
export function encodeWavPcm16(pcm: Int16Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buffer, 44).set(pcm);
  return buffer;
}

/** Chunked base64 (avoids call-stack overflow on multi-MB payloads). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 32 * 1024;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export class VoiceRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private totalFrames = 0;
  private startedAt = 0;

  get isRecording(): boolean {
    return this.ctx !== null;
  }

  /** Elapsed recording seconds (for the UI timer). */
  elapsedSeconds(): number {
    if (!this.startedAt) return 0;
    return Math.min(MAX_SECONDS, Math.round((Date.now() - this.startedAt) / 1000));
  }

  async start(): Promise<void> {
    if (this.isRecording) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("此环境不支持录音");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream = stream;
    // Request 16 kHz directly — Chrome/WebView honor it, so no resampling needed.
    const Ctor: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) throw new Error("此环境不支持录音");
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ sampleRate: VOICE_SAMPLE_RATE });
    } catch {
      ctx = new Ctor(); // fall back to device rate; we resample below if needed
    }
    await ctx.resume().catch(() => undefined);
    this.ctx = ctx;

    const source = ctx.createMediaStreamSource(stream);
    this.source = source;
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    this.processor = processor;
    processor.onaudioprocess = (e) => {
      if (!this.ctx) return; // stopped mid-callback
      let data: Float32Array = e.inputBuffer.getChannelData(0).slice();
      const rate = this.ctx.sampleRate;
      if (rate !== VOICE_SAMPLE_RATE) data = resampleLinear(data, rate, VOICE_SAMPLE_RATE);
      this.chunks.push(data);
      this.totalFrames += data.length;
    };
    source.connect(processor);
    // ScriptProcessor must be connected to the destination to fire on some engines.
    processor.connect(ctx.destination);
    this.startedAt = Date.now();

    // Auto-stop at MAX_SECONDS (the frame budget is finite).
    window.setTimeout(() => {
      if (this.isRecording && this.elapsedSeconds() >= MAX_SECONDS) void this.stop().catch(() => undefined);
    }, (MAX_SECONDS + 1) * 1000);
  }

  /** Stop and return the recording as base64 WAV (16 kHz mono PCM16). */
  async stop(): Promise<{ audioB64: string; sampleRate: number }> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("未在录音");
    this.cleanup();
    await ctx.close().catch(() => undefined);

    const merged = new Float32Array(this.totalFrames);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    if (merged.length < VOICE_SAMPLE_RATE * 0.5) throw new Error("录音太短");
    const wav = encodeWavPcm16(floatToPcm16(merged), VOICE_SAMPLE_RATE);
    return { audioB64: arrayBufferToBase64(wav), sampleRate: VOICE_SAMPLE_RATE };
  }

  /** Abort without producing a result (user cancelled). */
  cancel(): void {
    const ctx = this.ctx;
    this.cleanup();
    if (ctx) void ctx.close().catch(() => undefined);
  }

  private cleanup(): void {
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
    } catch {
      // already disconnected
    }
    this.processor = null;
    this.source = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.ctx = null;
    this.startedAt = 0;
  }
}

/** Simple linear resampler (only used when the device ignores sampleRate=16k). */
function resampleLinear(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return input;
  const n = Math.round((input.length * dstRate) / srcRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = (i * srcRate) / dstRate;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = pos - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

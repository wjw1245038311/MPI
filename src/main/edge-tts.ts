/**
 * Edge TTS — free, key-less online neural voices, synthesized in the main
 * process (so the renderer never talks to Microsoft directly and the audio can
 * be cached/handled without CORS concerns).
 *
 * This speaks Microsoft Edge's "Read Aloud" WebSocket protocol. It is an
 * undocumented endpoint: no API key is required, but the server expects a
 * `Sec-MS-GEC` anti-abuse token derived from the current time and a well-known
 * client token, plus browser-like headers. If Microsoft changes any of this the
 * call fails — callers must fall back to the offline `speechSynthesis` engine
 * (see src/renderer/src/lib/tts.ts), which is why this module only ever returns
 * a result object and never throws.
 *
 * Pure helpers (edgeGecToken / buildEdgeSsml / parseEdgeFrame / edgeRateString)
 * are exported for the strip-types test runner; the network path is injected
 * (`wsImpl`) so tests never open a socket.
 */
import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";

/** Public token Microsoft ships inside their own Edge client. */
export const EDGE_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

const EDGE_ENDPOINT =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

/** Chromium build advertised to Edge; the server rejects stale client versions.
 * Keep in sync with the current Microsoft Edge release (bump when synthesis
 * starts failing with 403 — e.g. 141 → 143 on 2026-09-12). */
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

const DEFAULT_EDGE_VOICE = "en-US-AriaNeural";

const SYNTH_TIMEOUT_MS = 60_000;

/** Edge caps an utterance; the renderer chunks long replies well below this. */
export const EDGE_MAX_TEXT_CHARS = 4000;

export interface EdgeSynthResult {
  ok: boolean;
  /** MP3 audio, base64 (renderer builds a Blob URL from it). */
  audioBase64?: string;
  mime?: string;
  /** i18n key (voice.tts.*) or a short upstream detail. */
  error?: string;
}

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested in scripts/test-edge-tts.mjs)
 * ------------------------------------------------------------------ */

/** Windows file-time epoch (seconds between 1601-01-01 and 1970-01-01). */
const WINDOWS_EPOCH_OFFSET = 11_644_473_600;

/**
 * The `Sec-MS-GEC` anti-abuse token. Microsoft's client computes it from the
 * current time rounded down to a 5-minute window:
 *   ticks = (unixSeconds + WINDOWS_EPOCH) rounded down to 300
 *   token = SHA256(decimal(ticks * 1e7) + TRUSTED_CLIENT_TOKEN), hex, uppercased
 * `dateMs` is injected so the function stays pure and testable.
 */
export function edgeGecToken(dateMs: number, token = EDGE_TRUSTED_CLIENT_TOKEN): string {
  let ticks = dateMs / 1000 + WINDOWS_EPOCH_OFFSET;
  ticks -= ticks % 300;
  const strTicks = Math.round(ticks * 1e7).toString();
  return createHash("sha256").update(strTicks + token, "ascii").digest("hex").toUpperCase();
}

/** A 32-hex connection/request id, as Edge expects. */
export function edgeConnectionId(): string {
  return randomBytes(16).toString("hex");
}

/** Full WebSocket URL with the GEC + connection parameters. */
export function edgeWsUrl(connectionId: string, dateMs: number): string {
  const params = new URLSearchParams({
    TrustedClientToken: EDGE_TRUSTED_CLIENT_TOKEN,
    "Sec-MS-GEC": edgeGecToken(dateMs),
    "Sec-MS-GEC-Version": SEC_MS_GEC_VERSION,
    ConnectionId: connectionId,
  });
  return `${EDGE_ENDPOINT}?${params.toString()}`;
}

/** XML-escape text before embedding it in SSML. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** "zh-CN-XiaoxiaoNeural" → "zh-CN"; falls back to en-US for odd names. */
export function voiceLang(voice: string): string {
  const m = /^([a-z]{2}-[A-Z]{2})/.exec(voice || "");
  return m ? m[1] : "en-US";
}

/** UI rate multiplier (0.5–2) → Edge prosody rate string ("-50%"…"+100%"). */
export function edgeRateString(rate: number | undefined): string {
  const r = typeof rate === "number" && Number.isFinite(rate) ? rate : 1;
  const pct = Math.round(Math.min(2, Math.max(0.5, r)) * 100 - 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

/** Build the SSML body Edge expects. */
export function buildEdgeSsml(text: string, voice: string, rate: string): string {
  const v = voice || DEFAULT_EDGE_VOICE;
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' " +
    `xml:lang='${voiceLang(v)}'><voice name='${v}'><prosody pitch='+0Hz' ` +
    `rate='${rate}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`
  );
}

/**
 * WS message frame: header lines, a blank line, then the body. Edge expects
 * CRLF separators.
 */
export function edgeTextFrame(headers: Record<string, string>, body = ""): string {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}:${v}`)
    .join("\r\n");
  return `${head}\r\n\r\n${body}`;
}

export interface EdgeFrame {
  /** Lower-cased header map (e.g. path, content-type). */
  headers: Record<string, string>;
  path: string;
  payload: Buffer;
}

/**
 * Parse a binary Edge frame: a 2-byte big-endian header length, that many bytes
 * of CRLF header text, then the payload (audio for `Path:audio`).
 */
export function parseEdgeFrame(data: Buffer): EdgeFrame {
  const headerLen = data.readUInt16BE(0);
  const headerText = data.subarray(2, 2 + headerLen).toString("utf8");
  const payload = data.subarray(2 + headerLen);
  const headers: Record<string, string> = {};
  for (const line of headerText.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { headers, path: headers.path || "", payload };
}

/* ------------------------------------------------------------------ *
 * Network path
 * ------------------------------------------------------------------ */

export interface EdgeSynthDeps {
  /** Injectable WebSocket constructor (tests). */
  wsImpl?: typeof WebSocket;
  /** Injectable clock (tests). */
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Synthesize `text` with an Edge neural voice. Resolves to `{ ok:false, error }`
 * on every failure — this function never rejects, so callers can fall back to
 * the system TTS without a try/catch dance.
 */
export async function synthesizeEdge(
  args: { text?: string; voice?: string; rate?: number },
  deps: EdgeSynthDeps = {},
): Promise<EdgeSynthResult> {
  const text = (args?.text || "").trim();
  if (!text) return { ok: false, error: "voice.tts.empty-text" };
  if (text.length > EDGE_MAX_TEXT_CHARS) return { ok: false, error: "voice.tts.too-long" };

  const voice = (args?.voice || "").trim() || DEFAULT_EDGE_VOICE;
  const rate = edgeRateString(args?.rate);
  const WS = deps.wsImpl || WebSocket;
  const now = deps.now || Date.now;
  const dateMs = now();
  const requestId = edgeConnectionId();

  return await new Promise<EdgeSynthResult>((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let ws: WebSocket;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (result: EdgeSynthResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    try {
      ws = new WS(edgeWsUrl(requestId, dateMs), {
        headers: {
          Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          "User-Agent": USER_AGENT,
          Pragma: "no-cache",
          "Cache-Control": "no-cache",
        },
      });
    } catch (e: any) {
      resolve({ ok: false, error: `voice.tts.edge:${String(e?.message || e)}` });
      return;
    }

    timer = setTimeout(() => finish({ ok: false, error: "voice.tts.timeout" }), deps.timeoutMs ?? SYNTH_TIMEOUT_MS);

    ws.on("open", () => {
      try {
        ws.send(
          edgeTextFrame(
            {
              "X-Timestamp": new Date(dateMs).toISOString(),
              "Content-Type": "application/json; charset=utf-8",
              Path: "speech.config",
            },
            JSON.stringify({
              context: {
                synthesis: {
                  audio: {
                    metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                    outputFormat: OUTPUT_FORMAT,
                  },
                },
              },
            }),
          ),
        );
        ws.send(
          edgeTextFrame(
            {
              "X-RequestId": requestId,
              "Content-Type": "application/ssml+xml",
              "X-Timestamp": new Date(dateMs).toISOString(),
              Path: "ssml",
            },
            buildEdgeSsml(text, voice, rate),
          ),
        );
      } catch (e: any) {
        finish({ ok: false, error: `voice.tts.edge:${String(e?.message || e)}` });
      }
    });

    ws.on("message", (data: any, isBinary: boolean) => {
      const buf: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
      if (!isBinary) {
        // Control frames carry a Path header as plain text.
        if (buf.toString("utf8").includes("Path:turn.end")) {
          if (!chunks.length) finish({ ok: false, error: "voice.tts.no-audio" });
          else finish({ ok: true, audioBase64: Buffer.concat(chunks).toString("base64"), mime: "audio/mpeg" });
        }
        return;
      }
      try {
        const frame = parseEdgeFrame(buf);
        if (frame.path === "audio" && frame.payload.length) chunks.push(Buffer.from(frame.payload));
      } catch {
        // A malformed frame shouldn't abort a synthesis that may still complete.
      }
    });

    ws.on("error", (e: any) => finish({ ok: false, error: `voice.tts.edge:${String(e?.message || e)}` }));
    ws.on("close", () => finish({ ok: false, error: "voice.tts.closed" }));
  });
}

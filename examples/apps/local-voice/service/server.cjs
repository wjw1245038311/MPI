#!/usr/bin/env node
/**
 * Local STT server — an OpenAI-compatible ASR endpoint backed by sherpa-onnx.
 *
 * This file is part of an MPI *app package* (see examples/apps/local-voice/).
 * It is intentionally self-contained: it loads the sherpa-onnx native runtime
 * and the speech model that ship INSIDE the app package, so it needs no system
 * Python/Node and no network. MPI launches it with:
 *
 *   ELECTRON_RUN_AS_NODE=1 <MPI executable> server.cjs --port <port>
 *
 * Layout it expects (relative to the app root, i.e. this file's parent dir):
 *   runtime/node_modules/sherpa-onnx-node/   vendored native runtime
 *   model/model.json                         model descriptor
 *   model/<model.int8.onnx>, model/tokens.txt
 *
 * model.json:
 *   { "type": "senseVoice" | "paraformer",
 *     "model": "model.int8.onnx", "tokens": "tokens.txt",
 *     "name": "SenseVoiceSmall", "language": "auto",
 *     "useInverseTextNormalization": true }
 *
 * Endpoints:
 *   GET  /v1/models                     -> { object, data:[{id,...}] }
 *   POST /v1/audio/transcriptions       -> { text }  (multipart, field "file")
 */
"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const APP_DIR = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { port: 8800, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i] === "--host") out.host = argv[++i];
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) out.port = 8800;
  return out;
}

/** Load the vendored sherpa runtime (a clear error beats a raw require crash). */
function loadSherpa() {
  const runtimeDir = path.join(APP_DIR, "runtime", "node_modules", "sherpa-onnx-node");
  if (!fs.existsSync(runtimeDir)) {
    throw new Error(
      `Bundled runtime missing: ${runtimeDir}\n` +
        "This app package was not built with a runtime — rebuild it with scripts/build-app-pack.mjs.",
    );
  }
  return require(runtimeDir);
}

function loadModelDescriptor() {
  const modelDir = path.join(APP_DIR, "model");
  const descriptorPath = path.join(modelDir, "model.json");
  if (!fs.existsSync(descriptorPath)) {
    throw new Error(`Model descriptor missing: ${descriptorPath}`);
  }
  const desc = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  const resolveIn = (rel) => (path.isAbsolute(rel) ? rel : path.join(modelDir, rel));
  const model = resolveIn(desc.model || "model.int8.onnx");
  const tokens = resolveIn(desc.tokens || "tokens.txt");
  for (const [label, p] of [["model", model], ["tokens", tokens]]) {
    if (!fs.existsSync(p)) throw new Error(`Model file missing (${label}): ${p}`);
  }
  return { ...desc, modelPath: model, tokensPath: tokens };
}

function buildRecognizer(sherpa, desc) {
  const modelConfig = { tokens: desc.tokensPath, numThreads: desc.numThreads || 2, provider: "cpu", debug: 0 };
  const type = String(desc.type || "senseVoice");
  if (type === "paraformer") {
    modelConfig.paraformer = { model: desc.modelPath };
  } else if (type === "senseVoice") {
    modelConfig.senseVoice = {
      model: desc.modelPath,
      language: desc.language || "auto",
      useInverseTextNormalization: desc.useInverseTextNormalization !== false,
    };
  } else {
    throw new Error(`Unsupported model type: ${type}`);
  }
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig,
  });
  return rec;
}

/** Minimal multipart/form-data parser (MPI uploads one `file` part + fields). */
function parseMultipart(body, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let idx = body.indexOf(delim);
  while (idx !== -1) {
    let start = idx + delim.length;
    const after = body.toString("ascii", start, start + 2);
    if (after === "--") break; // closing delimiter
    if (after === "\r\n") start += 2;
    const next = body.indexOf(delim, start);
    if (next === -1) break;
    let end = next;
    if (body.toString("ascii", end - 2, end) === "\r\n") end -= 2;
    const chunk = body.subarray(start, end);
    const sep = chunk.indexOf("\r\n\r\n");
    if (sep !== -1) {
      const headerText = chunk.subarray(0, sep).toString("utf8");
      const name = (/name="([^"]*)"/i.exec(headerText) || [])[1] || "";
      const filename = (/filename="([^"]*)"/i.exec(headerText) || [])[1] || "";
      parts.push({ name, filename, content: chunk.subarray(sep + 4) });
    }
    idx = next;
  }
  return parts;
}

function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Decode a 16 kHz mono PCM WAV into a Float32Array (resamples if needed). */
function wavToSamples(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("unsupported audio: expected a RIFF/WAVE file");
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("unsupported WAV: missing fmt/data chunk");
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV: expect 16-bit PCM (got format=${fmt.format}, bits=${fmt.bits})`);

  const channels = fmt.channels || 1;
  const frames = Math.floor(data.length / (2 * channels));
  let samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2) / 32768;
    samples[i] = sum / channels;
  }
  if (fmt.sampleRate && fmt.sampleRate !== 16000) samples = resample(samples, fmt.sampleRate, 16000);
  return { samples, sampleRate: 16000 };
}

/** Linear resampler (mono Float32) — enough for speech, no extra deps. */
function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

function transcribe(recognizer, samples) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples });
  recognizer.decode(stream);
  return recognizer.getResult(stream).text || "";
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  res.end(body);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sherpa = loadSherpa();
  const descriptor = loadModelDescriptor();
  const recognizer = buildRecognizer(sherpa, descriptor);
  const modelName = descriptor.name || (descriptor.type === "paraformer" ? "paraformer" : "SenseVoiceSmall");
  const startedAt = Math.floor(Date.now() / 1000);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${args.host}:${args.port}`);
      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        return sendJson(res, 200, {
          object: "list",
          data: [{ id: modelName, object: "model", created: startedAt, owned_by: "mpi-local-voice" }],
        });
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { status: "ok", model: modelName });
      }
      if (req.method === "POST" && url.pathname.endsWith("/audio/transcriptions")) {
        const body = await readBody(req);
        const ctype = String(req.headers["content-type"] || "");
        const boundary = (/boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype) || []).slice(1).find(Boolean);
        let audio = null;
        if (boundary) {
          const filePart = parseMultipart(body, boundary.trim()).find((p) => p.name === "file" && p.content.length > 0);
          audio = filePart ? filePart.content : null;
        } else {
          audio = body; // raw audio body fallback
        }
        if (!audio || audio.length === 0) return sendJson(res, 400, { error: { message: "missing audio file (multipart field \"file\")" } });
        const { samples } = wavToSamples(audio);
        const text = transcribe(recognizer, samples);
        return sendJson(res, 200, { text });
      }
      return sendJson(res, 404, { error: { message: `unknown endpoint: ${req.method} ${url.pathname}` } });
    } catch (e) {
      return sendJson(res, 500, { error: { message: e && e.message ? e.message : String(e) } });
    }
  });

  server.on("error", (e) => {
    console.error(`[local-voice] server error: ${e.message}`);
    process.exit(1);
  });
  server.listen(args.port, args.host, () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === "object" ? addr.port : args.port;
    console.log(`[local-voice] listening on http://${args.host}:${actualPort}/v1 (model=${modelName})`);
  });

  const shutdown = () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();

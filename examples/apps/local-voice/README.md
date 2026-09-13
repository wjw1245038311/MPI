# 本地语音服务 / Local Voice Service (example app)

这是 MPI 应用商店的一个**开发者示例应用包**，用来演示「平台化」能力：应用自带
`mpi-app.json` 清单、主进程 service 模块、sherpa-onnx 原生运行时与语音模型，安装后
一键启用即可离线语音识别，MPI 本体不含任何应用载荷。

This is a **developer sample app package** for the MPI App Store. It demonstrates the
platform model: the app carries its own manifest, a main-process service module, the
sherpa-onnx native runtime and a speech model. After install + enable it transcribes
offline with zero configuration, and MPI itself ships no app payload.

## Layout

```
examples/apps/local-voice/
  mpi-app.json          # manifest (id/name/config fields/service/integrations/capabilities)
  service/index.cjs     # service lifecycle: probe external STT or spawn the bundled server
  service/server.cjs    # OpenAI-compatible ASR server (sherpa-onnx), reads runtime/ + model/
  runtime/              # NOT committed — filled by build-app-pack.mjs (sherpa-onnx-node)
  model/                # NOT committed — filled by build-app-pack.mjs (model.json + onnx + tokens)
```

## Build a self-contained package

```bash
node scripts/build-app-pack.mjs --app=examples/apps/local-voice
```

This installs the current-platform `sherpa-onnx-node` into a staging `runtime/`, downloads a
speech model into `model/`, and writes `local-voice-<platform>-<arch>.zip` (the artifact is
a developer product — it is **not** shipped inside the MPI installer).

Then open MPI → 应用商店 (App Store) → **从 zip 安装** and pick the zip.

## Run without building (developer workflow)

Assemble `runtime/` + `model/` in place, then use **加载目录** to install the folder directly.

## Modes

- **Bundled (default)** — leave “服务地址” empty; the app starts `server.cjs` on a loopback
  port using MPI's own executable as a Node runtime (`ELECTRON_RUN_AS_NODE`), then points
  MPI voice settings at `http://127.0.0.1:<port>/v1`.
- **External** — fill in your own OpenAI-compatible STT `/v1` URL; the app only probes it and
  wires MPI to it (no bundled server).

Disabling the app stops the server and restores the previous voice settings exactly.

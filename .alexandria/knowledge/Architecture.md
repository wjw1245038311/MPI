---
architecture: MPI
source: manual
tags: [electron, desktop, pi-agent]
---

# MPI Architecture

MPI is an Electron desktop app (TypeScript, electron-vite) that wraps the pi coding agent: a React renderer for chat/settings UI, a main process hosting all services and IPC handlers, and pi CLI child processes managed over RPC.

## Context

- **Module path:** repository root (`src/`)
- **Dependencies:** Electron, React, pi runtime (bundled or user-installed), local mem0 server (optional)
- **Consumers:** end users via packaged installers; developers via `npm run dev`

## Architecture

```
src/renderer  React UI (chat, settings, file tree) — state in store.ts
     |  contextBridge API (window.mpi.*)
src/preload   thin bridge: renderer <-> main IPC surface
     |  ipcRenderer.invoke / on
src/main      all services + registerIpc() wiring
     |-- pi-bridge.ts    PiBridge: spawns pi CLI child process, RPC protocol
     |-- messaging/      Feishu (Lark WS) + WeChat remote channels -> agent jobs
     |-- permission-gate*.ts   task-mode enforcement for the pi session
     |-- model-*         provider/model catalog, context-window probing, autopilot
     |-- automation.ts   scheduled tasks driving headless agent runs
```

## Data Flow

```
user input (renderer) --> preload bridge --> ipc handler (registerIpc in src/main/ipc.ts)
  --> PiBridge (src/main/pi-bridge.ts) sends prompt to pi CLI child process over RPC
  --> streaming events flow back: pi child -> PiBridge -> IPC -> renderer store -> UI

remote path: Feishu WS push --> messaging/service.ts handleIncoming --> runJob
  --> same PiBridge/agent-session layer (see domains/FeishuMessaging.md)
```

## Key Claims

- [extracted] `PiBridge` is defined at `src/main/pi-bridge.ts` and owns the pi CLI child-process lifecycle and RPC protocol.
- [extracted] `registerIpc` is defined at `src/main/ipc.ts` and wires every renderer-facing IPC handler in one place.
- [inferred] The main process is the only layer that may spawn processes or touch the filesystem for agent work; the renderer stays sandboxed behind the preload bridge.

## Boundaries

- This document does **not** cover mobile/Android clients (`mobile/`, `android/`) — separate codebases with their own concerns.
- Does not cover pi runtime internals (the pi CLI itself is an external dependency, see docs for its protocol).

## Evidence

- `PiBridge` defined at `src/main/pi-bridge.ts`
- `registerIpc` defined at `src/main/ipc.ts`
- `ensureWarmBridge` defined at `src/main/ipc.ts`
- `FeishuMessagingService` defined at `src/main/messaging/service.ts`

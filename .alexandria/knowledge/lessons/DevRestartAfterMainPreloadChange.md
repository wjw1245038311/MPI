---
lesson: dev-restart-after-main-preload-change
module: src/main
tags: [electron-vite, hmr, ipc, dev-workflow]
source: manual
guard-strength: directive
applies-when: [dev-running]
depends-on: electron-vite dev process model (npm run dev)
---

# Dev restart required after main/preload changes

## Symptom

After editing `src/main/**` or `src/preload/**`, pressing Ctrl+R in the running app shows no effect — new IPC handlers are missing, preload-exposed APIs stay stale, and features "silently not working" while renderer code (which did reload) looks fine.

## Root Cause

electron-vite dev hot-reloads only the renderer bundle. The main process and preload scripts run in separate Node contexts that HMR does not restart; a Ctrl+R reload reuses the old main/preload processes, so any change there is invisible until the whole app cold-starts again.

## Fix

Stop the `npm run dev` process entirely (Ctrl+C) and start it again — full cold start of main + preload + renderer.

## Guard

Before verifying ANY change under `src/main/` or `src/preload/`, do a full dev-process restart; never rely on Ctrl+R for those layers. Renderer-only changes may use Ctrl+R.

## Evidence

- `registerIpc` defined at `src/main/ipc.ts`
- `ensureWarmBridge` defined at `src/main/ipc.ts`

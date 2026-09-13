import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// electron-vite builds three targets:
//  - main:    Node process that spawns `pi --mode rpc` and bridges JSONL <-> IPC
//  - preload: contextBridge surface exposed to the renderer
//  - renderer: React UI (chat, sidebar, preview panes)
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    // Pin the dev-server port. On Windows with Hyper-V/WSL2 (e.g. Docker Desktop)
    // running, 127.0.0.1:5173 can fall inside a dynamic excluded-port range and
    // fail with EACCES instead of EADDRINUSE — Vite only auto-increments on
    // EADDRINUSE, so it crashes otherwise (check:
    // `netsh interface ipv4 show excludedportrange protocol=tcp`).
    // main/preload read the actual URL from ELECTRON_RENDERER_URL, so any port works.
    server: { port: 6173 },
    resolve: {
      alias: {
        // The changelog lives at the repo root (outside the renderer root);
        // expose it under a stable specifier for the in-app viewer.
        "@repo-root": resolve(__dirname),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});

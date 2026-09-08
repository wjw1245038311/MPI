// Test-only bundle entry (consumed by scripts/build-tui-race-bundle.mjs):
// re-exports the TUI session manager plus loadConfig so the plain-node race
// test can initialize a throwaway config before driving the IPC handlers.
export * from "../src/main/tui";
export { loadConfig } from "../src/main/config";

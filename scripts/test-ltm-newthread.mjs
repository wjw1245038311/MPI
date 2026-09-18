/** LongTaskMonitor × new-conversation repro (v0.6.17 follow-up: "遗漏了新对话").
 * Simulates the exact renderer flow for a brand-new conversation:
 *   openThread(cwd) → tempId placeholder → thread.open IPC → remap to sessionFile
 * then injects tool_execution_start/update/end events through handleEvent (the
 * same path usePiEvents uses) and checks what LongTaskMonitor's collectAgentTasks
 * would see for the active thread. */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

// rAF drives scheduleEventFlush; in node, flush on next tick.
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const F1 = "C:\\Users\\Administrator\\.pi\\agent\\sessions\\--tmp-proj--\\2026-09-16T15-40-00Z_01a0b.jsonl";
let openCalls = 0;
globalThis.window = {
  pi: {
    thread: {
      open: async (args) => {
        openCalls++;
        await new Promise((r) => setTimeout(r, 30)); // simulate IPC + warm-spare adoption latency
        return {
          threadId: F1,
          cwd: args.cwd,
          sessionFile: F1,
          sessionName: null,
          model: null,
          thinkingLevel: "off",
          isStreaming: false,
          messages: [],
          branchMessages: [],
          models: [],
          commands: [],
          permission: "sandbox",
          autoEnabled: false,
          isNewSession: true,
        };
      },
      getThinkingLevels: async () => ({ levels: ["off"] }),
      setTaskMode: async () => ({}),
      setPermission: async () => ({}),
      setThinking: async () => ({}),
    },
  },
};

const { useStore } = await import("../src/renderer/src/store.ts");

// --- 1. create the new conversation -----------------------------------------
const tempId = await useStore.getState().openThread("C:\\tmp\\proj");
assert.ok(tempId.startsWith("opening-"), "new thread returns a temp id, got: " + tempId);
let s = useStore.getState();
assert.equal(s.activeThreadId, tempId);
assert.ok(s.threads[tempId], "placeholder exists under temp id");

// --- 2. wait for the connect/remap ------------------------------------------
await new Promise((r) => setTimeout(r, 150));
s = useStore.getState();
console.log("after remap: activeThreadId =", s.activeThreadId);
console.log("thread keys:", Object.keys(s.threads).join(", "));
assert.equal(s.activeThreadId, F1, "activeThreadId must be remapped to the session file");
assert.ok(s.threads[F1], "thread state lives under the session file key");
assert.equal(s.threads[tempId], undefined, "temp id key must be gone after remap");

// --- 3. long bash tool call starts (what main would send) --------------------
useStore.getState().handleEvent(F1, {
  type: "tool_execution_start",
  toolCallId: "call-1",
  toolName: "bash",
  args: { command: "sleep 60 && echo done" },
});
await new Promise((r) => setTimeout(r, 50)); // rAF flush
s = useStore.getState();
const run = s.threads[F1]?.toolRuns?.["call-1"];
console.log("toolRun:", JSON.stringify(run && { running: run.running, name: run.name, startedAt: !!run.startedAt }));
assert.ok(run, "tool_execution_start must land on the remapped thread");
assert.equal(run.running, true);

// --- 4. what LongTaskMonitor.collectAgentTasks would see --------------------
const s2 = useStore.getState();
const t = s2.threads[s2.activeThreadId];
const running = Object.values(t?.toolRuns || {}).filter((r) => r.running);
console.log("monitor view: activeThreadId =", s2.activeThreadId, "→ running tasks:", running.length);
assert.equal(running.length, 1, "the monitor must see the running task in a brand-new conversation");

// --- 5. partial output updates keep it alive ---------------------------------
useStore.getState().handleEvent(F1, {
  type: "tool_execution_update",
  toolCallId: "call-1",
  toolName: "bash",
  args: {},
  partialResult: { content: [{ type: "text", text: "still running…" }] },
});
await new Promise((r) => setTimeout(r, 50));
const run2 = useStore.getState().threads[F1].toolRuns["call-1"];
assert.equal(run2.running, true);
assert.ok(String(run2.partialText || "").includes("still running"), "partial output must tail into the monitor");

console.log("\nPASS new-conversation flow: remap + tool events + monitor view all consistent");
process.exit(0);

/** LongTaskMonitor leak repro — user report (v0.6.17): "有一个对话在执行长任务，
 * 等待期间又新建了一个对话，结果新建的对话出现了长任务进度条".
 * Simulates: A running a long bash task → createThread(B) while A streams →
 * verify the monitor view for B stays empty and A's events never leak into B. */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const A_KEY = "C:\\Users\\Administrator\\.pi\\agent\\sessions\\--tmp-proj--\\A-session.jsonl";
const B_FILE = "C:\\Users\\Administrator\\.pi\\agent\\sessions\\--tmp-proj--\\B-session.jsonl";
let openCalls = 0;
globalThis.window = {
  pi: {
    thread: {
      open: async (args) => {
        openCalls++;
        await new Promise((r) => setTimeout(r, 30));
        return {
          // A resume returns its own key; a fresh conversation gets B_FILE.
          threadId: args.sessionFile || B_FILE,
          cwd: args.cwd,
          sessionFile: args.sessionFile || B_FILE,
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
          isNewSession: !args.sessionFile,
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

// --- seed A as an open conversation with a running long bash task -----------
useStore.setState({
  threads: {
    [A_KEY]: {
      isStreaming: true,
      streaming: null,
      cwd: "C:\\tmp\\proj",
      sessionFile: A_KEY,
      messages: [],
      blocks: [],
      toolRuns: {
        "call-A1": { id: "call-A1", name: "bash", args: { command: "sleep 60" }, running: true, startedAt: Date.now() - 30_000 },
      },
    },
  },
  openThreadIds: [A_KEY],
  activeThreadId: A_KEY,
});

// sanity: while on A the monitor sees the task
let s = useStore.getState();
assert.equal(Object.values(s.threads[s.activeThreadId].toolRuns).filter((r) => r.running).length, 1);
console.log("on A: monitor sees", Object.values(s.threads[A_KEY].toolRuns).filter((r) => r.running).length, "running task ✓");

// --- create new conversation B while A is still streaming --------------------
const tempId = await useStore.getState().openThread("C:\\tmp\\proj");
assert.ok(tempId.startsWith("opening-"));
s = useStore.getState();
console.log("right after create: activeThreadId =", s.activeThreadId === tempId ? "tempId_B ✓" : s.activeThreadId);
const leakNow = Object.values(s.threads[s.activeThreadId]?.toolRuns || {}).filter((r) => r.running).length;
assert.equal(leakNow, 0, "B (placeholder phase) must not show A's task");

// --- wait for B's connect/remap ----------------------------------------------
await new Promise((r) => setTimeout(r, 150));
s = useStore.getState();
console.log("after remap: activeThreadId =", s.activeThreadId);
assert.equal(s.activeThreadId, B_FILE, "active thread must be B");
const leakAfter = Object.values(s.threads[B_FILE]?.toolRuns || {}).filter((r) => r.running).length;
assert.equal(leakAfter, 0, "B (remapped) must not show A's task — THIS IS THE USER'S BUG IF IT FAILS");

// --- A keeps streaming while user sits on B ----------------------------------
useStore.getState().handleEvent(A_KEY, { type: "tool_execution_update", toolCallId: "call-A1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "tick" }] } });
await new Promise((r) => setTimeout(r, 50));
s = useStore.getState();
assert.equal(s.threads[A_KEY].toolRuns["call-A1"].running, true, "A's task keeps running");
const leakDuring = Object.values(s.threads[B_FILE]?.toolRuns || {}).filter((r) => r.running).length;
assert.equal(leakDuring, 0, "A's live events must not leak into B while user is on B");

// --- switch back to A: ring must come back there -----------------------------
useStore.getState().setActiveThread(A_KEY);
s = useStore.getState();
const backOnA = Object.values(s.threads[s.activeThreadId].toolRuns).filter((r) => r.running).length;
assert.equal(backOnA, 1, "switching back to A must show its task again");

console.log("\nPASS no leak: B stays clean while A runs; A keeps its own ring");
process.exit(0);

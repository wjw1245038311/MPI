/** extuiQueue cleanup tests — pending extension-UI dialogs must be dropped when
 * their thread's pi process exits or the thread is closed. Otherwise a full-screen
 * ExtUiModal backdrop (input/editor dialog) stays on screen and blocks the composer
 * ("输入框置灰打不了字" / input box greyed out, can't type). */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { useStore } = await import("../src/renderer/src/store.ts");

let passed = 0;
function ok(name) {
  passed++;
  console.log(`PASS ${name}`);
}

const threadStub = () => ({ isStreaming: true, streaming: null, cwd: "/tmp", sessionFile: null });

function seed(threadId, method) {
  useStore.setState({
    threads: { [threadId]: threadStub() },
    extuiQueue: [{ threadId, request: { id: `req-${method}`, method } }],
    toasts: [],
  });
}

// handleExit drops the exiting thread's pending dialogs.
{
  seed("t1", "input");
  useStore.getState().handleExit("t1", { code: 1, stderr: "" });
  assert.deepEqual(useStore.getState().extuiQueue, []);
  const t = useStore.getState().threads["t1"];
  assert.equal(t.isStreaming, false, "exit must still clear streaming state");
}
ok("handleExit clears the thread's pending ext-ui dialogs");

// Other threads' dialogs survive.
{
  seed("t1", "input");
  useStore.setState((s) => ({
    threads: { ...s.threads, t2: threadStub() },
    extuiQueue: [...s.extuiQueue, { threadId: "t2", request: { id: "req-editor", method: "editor" } }],
  }));
  useStore.getState().handleExit("t1", { code: 1, stderr: "" });
  const q = useStore.getState().extuiQueue;
  assert.equal(q.length, 1);
  assert.equal(q[0].threadId, "t2");
}
ok("handleExit only clears the exiting thread's dialogs");

// closeThread drops the closed thread's pending dialogs.
{
  seed("t3", "editor");
  await useStore.getState().closeThread("t3"); // window.pi is absent in node; close() throws and is swallowed
  assert.deepEqual(useStore.getState().extuiQueue, []);
  assert.equal(useStore.getState().threads["t3"], undefined);
}
ok("closeThread clears the closed thread's pending ext-ui dialogs");

console.log(`\n${passed} groups passed`);
// Toast timers from handleExit would otherwise keep node alive ~5s.
process.exit(0);

/** Automation ext-UI handler tests — unattended runs must not treat display-only
 * extension UI methods (notify / setStatus / setWidget / setTitle / set_editor_text)
 * as "needs human interaction". Regression: pi-mcp-adapter emits
 * `setStatus("mcp", …)` at session init whenever mcp.json lists a server, which made
 * every scheduled run fail with 定时任务需要人工交互（setStatus）. */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const mod = await import("../src/main/automation-ext-ui.ts");
const { isInteractiveExtUiMethod, createAutomationExtUiHandler } = mod;

let passed = 0;
function ok(name) {
  passed++;
  console.log(`PASS ${name}`);
}

// --- isInteractiveExtUiMethod: the full method set pi rpc-mode emits ---------
for (const m of ["select", "confirm", "input", "editor"]) {
  assert.equal(isInteractiveExtUiMethod(m), true, `${m} should be interactive`);
}
ok("dialog methods are interactive");

for (const m of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "", null, undefined, 42]) {
  assert.equal(isInteractiveExtUiMethod(m), false, `${String(m)} should be non-interactive`);
}
ok("fire-and-forget / unknown methods are non-interactive");

// --- handler behaviour --------------------------------------------------------
function makeHandler(over = {}) {
  const responses = [];
  const h = createAutomationExtUiHandler({
    respondExtUi: (id, payload) => responses.push({ id, payload }),
    ...over,
  });
  return { h, responses };
}

// Regression scenario: pi-mcp-adapter's init-time setStatus must not fail the run.
{
  const { h, responses } = makeHandler();
  h.handle({ id: "a1", method: "setStatus", statusKey: "mcp", statusText: "🔌 MCP: 1 server enabled" });
  assert.equal(h.cancelledMethod(), null);
  assert.deepEqual(responses, [{ id: "a1", payload: { cancelled: true } }]);
}
ok("setStatus is responded to but does not mark the run as interactive");

for (const method of ["notify", "setWidget", "setTitle", "set_editor_text"]) {
  const { h, responses } = makeHandler();
  h.handle({ id: "x1", method });
  assert.equal(h.cancelledMethod(), null);
  assert.equal(responses.length, 1, `${method} should still be responded to`);
}
ok("notify/setWidget/setTitle/set_editor_text are all non-interactive");

// Dialog methods still fail closed.
for (const m of ["select", "confirm", "input", "editor"]) {
  const { h } = makeHandler();
  h.handle({ id: "d1", method: m });
  assert.equal(h.cancelledMethod(), m);
}
ok("dialog methods are still recorded as needing human interaction");

// The first interactive method wins; later ones don't overwrite it.
{
  const { h } = makeHandler();
  h.handle({ id: "1", method: "setStatus" });
  h.handle({ id: "2", method: "confirm" });
  h.handle({ id: "3", method: "input" });
  assert.equal(h.cancelledMethod(), "confirm");
}
ok("first interactive method is recorded, later ones don't overwrite");

// Model-picker auto-answer path (options must look like provider/model ids).
const MODEL_OPTS = ["openai/gpt-5", "anthropic/claude-x"];
{
  const { h, responses } = makeHandler({ answerModelSelect: async () => true });
  h.handle({ id: "m1", method: "select", title: "Choose a model for web search", options: MODEL_OPTS });
  await new Promise((r) => setTimeout(r, 0)); // auto-answer resolves async
  assert.equal(h.cancelledMethod(), null);
  assert.equal(responses.length, 0, "auto-answered picker must not be cancelled");
}
ok("model select is auto-answered (no cancel response)");

{
  const { h } = makeHandler({ answerModelSelect: async () => false });
  h.handle({ id: "m2", method: "select", title: "Choose a model for web search", options: MODEL_OPTS });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.cancelledMethod(), "select");
}
ok("model select falls back to cancel when auto-answer fails");

console.log(`\n${passed} groups passed`);

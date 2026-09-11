import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { beginTransfer, cancelTransfer, endTransfer, getTransfers, setTransferBroadcaster, updateTransfer } = await import(
  "../src/main/transfer-monitor.ts"
);

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

// --- broadcast wiring + snapshot -------------------------------------------
const events = [];
setTransferBroadcaster((list) => events.push(list.map((t) => t.id)));

const id1 = beginTransfer({ kind: "download", label: "测试下载" });
assert.equal(getTransfers().length, 1);
assert.equal(getTransfers()[0].label, "测试下载");
ok("beginTransfer registers an entry and broadcasts immediately");

// --- byte progress + speed window ------------------------------------------
updateTransfer(id1, { doneBytes: 0, totalBytes: 1_000_000 });
await new Promise((r) => setTimeout(r, 300));
updateTransfer(id1, { doneBytes: 500_000 });
const t = getTransfers()[0];
assert.equal(t.doneBytes, 500_000);
assert.ok(t.speedBps > 0, "speed estimated from byte samples");
ok("updateTransfer tracks bytes and estimates speed");

// --- throttling -------------------------------------------------------------
events.length = 0;
for (let i = 1; i <= 20; i++) updateTransfer(id1, { doneBytes: i * 10 });
assert.ok(events.length < 20, "rapid updates are coalesced by the emit throttle");
ok("broadcasts are throttled to ~500ms");

// --- cancel -----------------------------------------------------------------
let cancelled = false;
const id2 = beginTransfer({ label: "可取消", cancellable: true, onCancel: () => (cancelled = true) });
assert.equal(cancelTransfer(id2), true);
assert.ok(cancelled, "onCancel invoked");
ok("cancelTransfer invokes the cancel callback");

const id3 = beginTransfer({ label: "不可取消" });
assert.equal(cancelTransfer(id3), false, "non-cancellable transfer refuses cancel");
ok("non-cancellable transfers refuse cancel");

// --- end --------------------------------------------------------------------
endTransfer(id1);
endTransfer(id2);
endTransfer(id3);
assert.equal(getTransfers().length, 0);
ok("endTransfer removes entries and broadcasts the empty list");

console.log(`\n${passed} checks passed`);

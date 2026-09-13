// L1: image copy-to-clipboard pipeline (right-click → 复制图片).
// The canvas/clipboard half needs a browser; here we cover the pure parts that
// decide which path an image takes and decode data URLs without any DOM.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

const { isPngDataUrl, dataUrlToBlob, IMAGE_COPY_SELECTOR } = await import("../src/renderer/src/lib/image-copy.ts");

// --- selector sanity ---------------------------------------------------------
for (const sel of ["img.msg-user-img", "img.md-img", "img.image-lightbox-img"]) {
  assert.ok(IMAGE_COPY_SELECTOR.includes(sel), `selector must cover ${sel}`);
}

// --- isPngDataUrl ------------------------------------------------------------
assert.equal(isPngDataUrl("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), true);
assert.equal(isPngDataUrl("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAAAAQAAD/2wBDAA"), false, "jpeg data url is not the png fast path");
assert.equal(isPngDataUrl("http://example.com/a.png"), false, "remote urls go through the canvas path");
assert.equal(isPngDataUrl("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"), false);
assert.equal(isPngDataUrl(""), false);

// --- dataUrlToBlob -----------------------------------------------------------
const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="; // 1x1 png
const blob = await dataUrlToBlob(`data:image/png;base64,${b64}`);
assert.equal(blob.type, "image/png");
assert.equal(blob.size, Buffer.from(b64, "base64").length, "decoded byte length must match the base64 payload");

console.log("image-copy ok (selector + png fast path)");

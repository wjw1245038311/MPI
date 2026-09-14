/**
 * S8 deployment mode: relay TLS termination + PWA static hosting.
 *
 * Part 1 (plain HTTP): RELAY_STATIC_DIR serves the built PWA — index.html at /,
 *   correct content types, no-cache for html, SPA fallback for extension-less
 *   routes (/thread/<id>), real 404 for missing assets, path traversal → 403.
 * Part 2 (TLS): RELAY_TLS_CERT/KEY switch the server to https/wss — healthz +
 *   static over TLS with an embedded self-signed cert, and a full WebSocket
 *   handshake (host.register → relay.ok) over wss://.
 */
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import https from "node:https";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_ENTRY = join(ROOT, "mobile", "relay", "index.mjs");

// Self-signed test cert (CN=localhost, SAN localhost/127.0.0.1, valid to 2036).
const TEST_CERT_B64 =
  "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tDQpNSUlESlRDQ0FnMmdBd0lCQWdJVVJGNGJ4alZHbDV2aVpQb2Q2U2NjUlhxYk5Tb3dEUVlKS29aSWh2Y05BUUVMDQpCUUF3RkRFU01CQUdBMVVFQXd3SmJHOWpZV3hvYjNOME1CNFhEVEkyTURreE5ERXdNVGsxTkZvWERUTTJNRGt4DQpNVEV3TVRrMU5Gb3dGREVTTUJBR0ExVUVBd3dKYkc5allXeG9iM04wTUlJQklqQU5CZ2txaGtpRzl3MEJBUUVGDQpBQU9DQVE4QU1JSUJDZ0tDQVFFQTZUMWJTUXdhRncrdnFsWjBEUEtNdnVjRkczZ0padDg5MUVUOSt1aWVBSnNzDQppQVRkK1FOUnFpTmYrdzl4dS9BUlhoZFhHSFdTdjM3bEtwYUtOdFoxSlRMenZ6cjVWY2xEaHZQK1RxaUsxb0VKDQpaYjh4dk84UDZISHViRWMwVXgvYTZTUkpSZnh6WUN2bktLZUNjY1ZoclJQR21RVDJTWlZxdnJubGd6bzZsdWVzDQppa1hCV2tSOVVVT1BKQ0lzc0JXZVZmSi9XbStpMWZmWm5kZHRvT1E1VmVuMnJYV2FEMEo2SVl5azQ3VTJrT29tDQpuN0N4c3N1S01Yc3NvMVI1aGx0Z1B4eUQvdUg3WTE5TTZaQWczZlBsR0UrZzd2TzN4bGpiSGhUSzlkbUVWVGdTDQpsQlBTYWVWdC9Ja1A4bG45ZHdvTVg1clYxa09ZaEFqd3N2anVvb1p2TVFJREFRQUJvMjh3YlRBZEJnTlZIUTRFDQpGZ1FVS0h0cUdDOXNUclZxaUREcThlclY5dE1Vc3I0d0h3WURWUjBqQkJnd0ZvQVVLSHRxR0M5c1RyVnFpRERxDQo4ZXJWOXRNVXNyNHdEd1lEVlIwVEFRSC9CQVV3QXdFQi96QWFCZ05WSFJFRUV6QVJnZ2xzYjJOaGJHaHZjM1NIDQpCSDhBQUFFd0RRWUpLb1pJaHZjTkFRRUxCUUFEZ2dFQkFDRE93MHJuZWEzcEhKN1pDQnNZSFpXQkJzNFY4NXpuDQpjczJoeThCMmphZDh6RGFBSmdvaWI4V1NsUCtzSDFTUmFsSXdIWkdSbG5RV0daV25NNk5RN1NHQk5KYkdvbFl3DQpEd2ZjencvVm9HbmtjeGlhbysyK29oV25NR241TGNnYUErK1FrSTFUdTREZytDeEJTVHRyVHg2Y1QybS80eVd0DQpSYVl5TC9ONVZ2UXZDTHc4QWhhUnJrL2NvNGJHdFFXK1ltVVdETGxaTVBReUQ0WXpYWEo4Wjg2L3RrSHpwZUhPDQpQRE51VVE3T3hkckpqU1dOQ2Z3WENyUVgzWFYyUFdoTDJoa3F5bGxOYlpJUjZ0YUN4S3NMVGtaMmF6UVZLVzBjDQptK1l4MU1RNW1vckV3ZFFKemk5bHMxVm9xWDFGMVhZSXdTYXdSbXdYeC9nVkhLOUp2T1J3RVVFPQ0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQ0K";
const TEST_KEY_B64 =
  "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tDQpNSUlFdlFJQkFEQU5CZ2txaGtpRzl3MEJBUUVGQUFTQ0JLY3dnZ1NqQWdFQUFvSUJBUURwUFZ0SkRCb1hENitxDQpWblFNOG95KzV3VWJlQWxtM3ozVVJQMzY2SjRBbXl5SUJOMzVBMUdxSTEvN0QzRzc4QkZlRjFjWWRaSy9mdVVxDQpsb28yMW5VbE12Ty9PdmxWeVVPRzgvNU9xSXJXZ1FsbHZ6Rzg3dy9vY2U1c1J6UlRIOXJwSkVsRi9ITmdLK2NvDQpwNEp4eFdHdEU4YVpCUFpKbFdxK3VlV0RPanFXNTZ5S1JjRmFSSDFSUTQ4a0lpeXdGWjVWOG45YWI2TFY5OW1kDQoxMjJnNURsVjZmYXRkWm9QUW5vaGpLVGp0VGFRNmlhZnNMR3l5NG94ZXl5alZIbUdXMkEvSElQKzRmdGpYMHpwDQprQ0RkOCtVWVQ2RHU4N2ZHV05zZUZNcjEyWVJWT0JLVUU5SnA1VzM4aVEveVdmMTNDZ3hmbXRYV1E1aUVDUEN5DQorTzZpaG04eEFnTUJBQUVDZ2dFQWFxSXhHbS9zZTYraHZleEJxV3U0Mmt5UGdyUDZCR3k2L1ZHL2xsZUVhVDJJDQplZlZUc0pXS1lCRkZQK2liTkhPNDFQNHh4UTUzMVpJRDN0a3RmbzNFeUFtSDg5MVlBaGIraHZRRlI5djVnY0ZEDQoxUjg0ODZxT2FOU3h6eElzdzNZMFpOUEFwajBaV0pZcDNHWGRGdnZKUU5KaVFUSktFWEU4K003UHRoUElscFdjDQpMbk1id2lYNXhKeXJ4enprYTZFQ0JxbGxGSnlDSUNhelFCU25wQzRZdzY5L1RTMmt1WG90eE1kaXJOekZGaGxBDQpSUTVHenNnOStKbTBQM3hDRmFxc2d0RVUzc1BiY0padEdnWUg5bGcyRGRJVW5SYjRDUnp6d1I2b0RhL3Njbnp5DQp0MnZGSHp1emNnalFpcnhSQ25mbEpQM1RTdXBJbks4K2FQZWI1WHl1K3dLQmdRRDl2S3BiK3JqQTFOd29lbTY0DQo0L3lEdmJIT3o1cHJkbGQ5OXJYN0htSWhrQng3ZEU4aTh5NzIzVndpNTFaK2dmalpaUmJubjhKcUt5WTNBOTV5DQpoME93NkhWSU5IbEVlM0d2K1NsU0NHOGlGRXdFVDFmSERvRGlPOXpGdEg3T0Y1VzNuSGFBTGh1RVJiWEN3TXBEDQpiUHh4YmVJcExVb3BWbno3RjA4b2U2bloxd0tCZ1FEclVlUTVMNGZnQmlhbzRsRUJ3WC8wbExxZGFZY051NkU4DQpFREJMZnJaczZEWWc1eW1SVE9GbFQ3ajdUd1oyeXJIRDV4TDJNd3kxQjRiTE1ST2N6YlhPdFRuazY3UC9rSkl3DQp3NFROUkcxTkFGQTdGbnhPRmg5bXVxcEMxRDByZURyZFBrTEZlcnorTE5EbFQ0K0lPSkU2cFVkQ1FEaEdlR0YwDQoxdVQydnJ3dU53S0JnSDZjYSsybHVCY1FvQ0xhcFBGQllqbGlxSnpuM3NnTXJ5KzlzYVR5emtpdEhtbEQ2bEVvDQpRNkVQWi9CS3UxQTVEckY3emVnYVFlcTBTVWRlZU50eFA0ZkJGdlRHcWxSUHZMVHdnWHZibFlqTjAvaTZsclJQDQpPbVNwTmtxNC9DVmVnMml4ZkRnTnlkRkE3NmVVaDlrSlF4WmVuR0dycGJ2bTJrcDRvUmswUzliVkFvR0JBSUxIDQpRalRkeTMrZks0RVVOYnpxRXZpVVo1bnYrZFNTQUN0bk84L1pIZjBzbUZoMDM4OFdrUFZDOXlVRGFDNUF1OGFKDQo5eW5JZVRscWMya2RYeTczekNDUzZ4ZmtQbWE3cStOWjVjWkdUeEJLS2t5TVZJejVFbjUvSXZ4OUEzblRHYk8zDQpWRmgzdSt6dWJ6SGhvMzBySXRzYTI1MWdIMlphcEo3UWh2THlVWmJGQW9HQUQxNXBkeUErVHpGcFFUcDA5Ni9oDQpDa1h0cElXRFZCRzFQYlVEYlA1c3RUU2ZEb2phdVY5OUFMQXhMRUVOTVpLejNibTNKZVJZaFEzQnZFTHJDb3c3DQplMktOVzdUby9lK2puM1Nmb2lHR28zbmwzZ0pPdFkrOFZlRzEraDk4ZTExNVkwcWNTN3pjZ3dGWmU4UDZUT3FEDQpTU0Fua3VSZndJRTVURWRoWGQ5YUxpUT0NCi0tLS0tRU5EIFBSSVZBVEUgS0VZLS0tLS0NCg==";

// --- relay child process ---------------------------------------------------------
function startRelay(extraEnv) {
  const child = spawn(process.execPath, [RELAY_ENTRY], {
    env: { ...process.env, RELAY_PORT: "0", RELAY_PING_MS: "500", RELAY_DEAD_MS: "1000", ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let buffer = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay did not become ready in 5s")), 5_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const m = buffer.match(/ready wss?:\/\/[^:]+:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`relay exited early (code ${code})`)));
  });
  return { child, ready };
}

function makeStaticDir() {
  const dir = mkdtempSync(join(tmpdir(), "mpi-relay-static-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>mpi-pwa</title><div id=root></div>");
  writeFileSync(join(dir, "manifest.webmanifest"), JSON.stringify({ name: "MPI", start_url: "/" }));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('pwa');");
  return dir;
}

async function part1Static() {
  const staticDir = makeStaticDir();
  const { child, ready } = startRelay({ RELAY_STATIC_DIR: staticDir });
  try {
    const port = await ready;
    const base = `http://127.0.0.1:${port}`;

    // / → index.html, no-cache (asset names are content-hashed)
    let res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.match(await res.text(), /mpi-pwa/);

    // asset with correct content type
    res = await fetch(`${base}/assets/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/javascript/);
    assert.match(await res.text(), /console\.log/);

    // HEAD shares GET's headers (download tools probe this way) but sends no body.
    res = await fetch(`${base}/assets/app.js`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/javascript/);
    assert.equal(await res.text(), "", "HEAD must not carry a body");

    // manifest content type
    res = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/manifest\+json/);

    // SPA deep link (extension-less) → index.html
    res = await fetch(`${base}/thread/thread-abc123`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /mpi-pwa/);

    // missing asset (has extension) → real 404, not the SPA fallback
    res = await fetch(`${base}/assets/nope.js`);
    assert.equal(res.status, 404);

    // path traversal → 403. Raw http.get: undici's URL parser would normalize
    // %2e dot-segments away before sending, so the wire bytes matter here.
    const trav = await new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/%2e%2e/%2e%2e/package.json" }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve({ status: r.statusCode, body }));
      });
      req.on("error", reject);
    });
    assert.equal(trav.status, 403);
    assert.ok(!trav.body.includes("mpi-relay"), "traversal must not leak files outside the static dir");

    // API routes still win over static serving
    res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).ok, true);
  } finally {
    child.kill();
    rmSync(staticDir, { recursive: true, force: true });
  }
  console.log("part1 (static hosting): passed");
}

async function part2Tls() {
  const staticDir = makeStaticDir();
  const certPath = join(staticDir, "cert.pem");
  const keyPath = join(staticDir, "key.pem");
  writeFileSync(certPath, Buffer.from(TEST_CERT_B64, "base64"));
  writeFileSync(keyPath, Buffer.from(TEST_KEY_B64, "base64"));
  const { child, ready } = startRelay({ RELAY_STATIC_DIR: staticDir, RELAY_TLS_CERT: certPath, RELAY_TLS_KEY: keyPath });
  // node https.get accepts the self-signed test cert via rejectUnauthorized.
  const get = (port, path) =>
    new Promise((resolve, reject) => {
      const req = https.get({ host: "127.0.0.1", port, path, rejectUnauthorized: false }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
    });
  try {
    const port = await ready;

    let res = await get(port, "/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).ok, true);

    res = await get(port, "/");
    assert.equal(res.status, 200);
    assert.match(res.body, /mpi-pwa/);

    // full WebSocket handshake over wss:// (host.register → relay.ok)
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false });
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", (e) => reject(new Error(`wss connect failed: ${e.message}`)));
    });
    const reply = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no relay.ok within 3s")), 3_000);
      ws.on("message", (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
      ws.send(JSON.stringify({ type: "host.register", hostId: "tls-test-host" }));
    });
    assert.equal(reply.type, "relay.ok");
    assert.equal(reply.role, "host");
    ws.close();
  } finally {
    child.kill();
    rmSync(staticDir, { recursive: true, force: true });
  }
  console.log("part2 (TLS + wss): passed");
}

const main = (async () => {
  await part1Static();
  await part2Tls();
  console.log("relay tls/static tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

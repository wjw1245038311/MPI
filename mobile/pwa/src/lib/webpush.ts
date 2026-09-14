/**
 * S7 WebPush (PWA side, docs/MOBILE-DESIGN.md §7).
 *
 * Browser path: register /sw.js → pushManager.subscribe with the relay's VAPID
 * public key (fetched from <relay origin>/api/v1/remote/web-push/vapid-public-key)
 * → report the PushSubscription to the host over the E2E-encrypted channel
 * (push.subscribe frame). The host persists it and syncs it to the relay, which
 * signs/encrypts pushes; the browser decrypts before sw.js sees event.data.
 *
 * Everything is best-effort: no service worker / denied permission / offline
 * relay → return null silently (the live approval card still works over WS).
 */

import type { RemotePushSubscription } from "../../../shared/protocol";

/** "ws://host:9001/ws" → "http://host:9001" (wss→https likewise). */
export function relayHttpOrigin(relayWsUrl: string): string | null {
  try {
    const u = new URL(relayWsUrl);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    u.protocol = u.protocol === "ws:" ? "http:" : "https:";
    u.pathname = "/";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** base64url VAPID key → the ArrayBuffer pushManager.subscribe expects. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function supported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window;
}

/**
 * Ensure a WebPush subscription exists and is reported to the host.
 * @param relayWsUrl the relay WebSocket URL from the pairing record.
 * @param report called with the (re)used or fresh subscription — send it as a
 *   push.subscribe frame over the encrypted channel.
 */
export async function ensureBrowserPush(
  relayWsUrl: string,
  report: (subscription: RemotePushSubscription) => Promise<unknown>,
): Promise<RemotePushSubscription | null> {
  if (!supported()) return null;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") return null;
      const origin = relayHttpOrigin(relayWsUrl);
      if (!origin) return null;
      const res = await fetch(`${origin}/api/v1/remote/web-push/vapid-public-key`);
      if (!res.ok) return null;
      const { publicKey } = (await res.json()) as { publicKey?: string };
      if (!publicKey) return null;
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const json = subscription.toJSON() as unknown as RemotePushSubscription;
    if (!json?.endpoint || !json?.keys?.p256dh) return null;
    await report(json);
    return json;
  } catch (error) {
    console.warn("[webpush] setup failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

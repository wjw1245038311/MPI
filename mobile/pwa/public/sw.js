/* MPI Mobile service worker (S7 WebPush, docs/MOBILE-DESIGN.md §7).
 * The browser decrypts the aes128gcm payload before it reaches us — event.data
 * is already plaintext JSON {kind, title, body, deepLink}. */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch { /* malformed payload — still show a generic notification */ }
  const title = typeof data.title === "string" && data.title ? data.title : "MPI 需要批准";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: "mpi-approval", // one live approval notification at a time
      data: { deepLink: typeof data.deepLink === "string" && data.deepLink ? data.deepLink : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.deepLink || "/", self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const win of windows) {
        if (new URL(win.url).origin === target.origin) {
          // An open app handles the deep link itself (SPA navigation): it keeps the
          // live E2E session, whereas WindowClient.navigate() would force a cold
          // load that races the hello/challenge handshake.
          win.postMessage({ type: "mpi:deeplink", url: target.pathname + target.search });
          return win.focus();
        }
      }
      return self.clients.openWindow(target.pathname + target.search);
    }),
  );
});

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { protocol } from "electron";
import { PDF_VIEWER_SCHEME as SCHEME } from "./pdf-viewer-url";

/**
 * Serves local PDF files to Chromium's built-in viewer. In dev the renderer
 * runs on http:// (Vite) and web pages may not load file:// URLs in iframes,
 * so previews route through this custom scheme instead — it works from any
 * origin (http dev server or file:// packaged build).
 *
 * URL shape: mpipdf://file/<base64url(absPath)>. The payload lives in the
 * PATHNAME, not the hostname — URL parsing lowercases hostnames and would
 * destroy the case-sensitive base64. URLs are only ever produced by our own
 * main process for a file the user explicitly opened; the handler re-validates
 * before reading.
 */
export function registerPdfViewerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

export function registerPdfViewerProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      const url = new URL(request.url);
      // pathname keeps its case (hostnames are lowercased by the parser).
      const encoded = decodeURIComponent(url.pathname).replace(/^\//, "");
      const target = Buffer.from(encoded, "base64url").toString("utf8");
      if (!isAbsolute(target) || !existsSync(target)) return new Response("Not found", { status: 404 });
      const st = statSync(target);
      if (st.isDirectory()) return new Response("Not a file", { status: 415 });
      const buf = readFileSync(target);

      // Basic Range support — the PDF viewer may request byte ranges for lazy
      // page loading of large documents.
      const range = request.headers.get("range");
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m && (m[1] || m[2])) {
          const start = m[1] ? Number(m[1]) : 0;
          const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
          if (start <= end && start < buf.length) {
            return new Response(buf.subarray(start, end + 1), {
              status: 206,
              headers: {
                "Content-Type": "application/pdf",
                "Content-Range": `bytes ${start}-${end}/${buf.length}`,
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-store",
              },
            });
          }
        }
      }

      const body = request.method === "HEAD" ? "" : buf;
      return new Response(body as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return new Response(String((error as Error)?.message || "Invalid pdf request"), { status: 400 });
    }
  });
}

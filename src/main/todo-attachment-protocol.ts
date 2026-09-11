import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { protocol } from "electron";
import { resolveAttachmentFile } from "./todo-store";

const SCHEME = "todoatt";

/** Content types for the file extensions we actually store. */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
};

/** Guess a MIME type from a file name (used for dialog-picked files). */
export function mimeForName(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] || "application/octet-stream";
}

/**
 * Serves todo attachment binaries to the renderer as <img src> / links.
 * URLs are only ever produced by our own renderer from known metadata
 * (todoatt://<uuid>.<ext>); resolveAttachmentFile re-validates the name shape
 * and containment in <userData>/todo-attachments/ before any read.
 */
export function registerTodoAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

export function registerTodoAttachmentProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      const url = new URL(request.url);
      // The attachment file name is the hostname (uuid + extension — both are
      // host-safe characters by construction).
      const target = resolveAttachmentFile(url.hostname);
      if (!target) return new Response("Not found", { status: 404 });
      const type = MIME_TYPES[extname(target).toLowerCase()] || "application/octet-stream";
      const body = request.method === "HEAD" ? "" : readFileSync(target);
      return new Response(body as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return new Response(String((error as Error)?.message || "Invalid attachment request"), { status: 400 });
    }
  });
}

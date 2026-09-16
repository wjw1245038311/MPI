/**
 * Pure URL helpers for the mpipdf:// viewer scheme (see pdf-viewer-protocol.ts).
 * Kept free of electron imports so node-based tests can use them.
 */
export const PDF_VIEWER_SCHEME = "mpipdf";

/**
 * Build the viewer URL for an absolute path. The payload lives in the PATHNAME,
 * not the hostname — URL parsing lowercases hostnames and would destroy the
 * case-sensitive base64.
 */
export function pdfViewerUrl(absPath: string): string {
  return `${PDF_VIEWER_SCHEME}://file/${Buffer.from(absPath, "utf8").toString("base64url")}`;
}

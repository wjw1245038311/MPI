/** Custom MIME type for in-app file drags (sidebar file tree → composer).
 *  OS-level drops expose `dataTransfer.files`, but drags started inside the app
 *  do not — so the absolute path is carried via this type instead. */
export const MPI_FILE_MIME = "application/x-mpi-file";

/** Custom MIME type for in-app session-reference drags (sidebar thread row →
 *  composer). The payload is a JSON string {file, title}; dropping it adds the
 *  session's .jsonl as an attachment the agent can read with its file tools. */
export const MPI_SESSION_MIME = "application/x-mpi-session";

export interface SessionDragPayload {
  /** Absolute path to the session .jsonl file. */
  file: string;
  /** Display title used for the attachment chip and the model-facing envelope. */
  title: string;
}

/** Parse + validate a session drag payload; null when absent or malformed. */
export function parseSessionDragPayload(raw: string): SessionDragPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionDragPayload>;
    if (typeof parsed?.file !== "string" || !parsed.file.trim()) return null;
    const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : "";
    return { file: parsed.file, title };
  } catch {
    return null;
  }
}

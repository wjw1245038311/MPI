/** Custom MIME type for in-app file drags (sidebar file tree → composer).
 *  OS-level drops expose `dataTransfer.files`, but drags started inside the app
 *  do not — so the absolute path is carried via this type instead. */
export const MPI_FILE_MIME = "application/x-mpi-file";

/** Marker for drags started from a popped-out preview window. Dropping such a
 *  drag back into the main window docks it: the tab is (re)activated there and
 *  the standalone window closes — VS Code-style docking between windows. */
export const MPI_PREVIEW_WINDOW_MIME = "application/x-mpi-preview-window";

/** Custom MIME type for in-app file drags (sidebar file tree → composer).
 *  OS-level drops expose `dataTransfer.files`, but drags started inside the app
 *  do not — so the absolute path is carried via this type instead. */
export const MPI_FILE_MIME = "application/x-mpi-file";

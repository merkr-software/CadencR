/**
 * Single source of truth for "what counts as a large file to open in the
 * editor".
 *
 * At or above this byte size the editor opens the file read-only: no syntax
 * highlighting, no LSP client, no auto-save — so CodeMirror stays responsive
 * even on multi-megabyte lockfiles. The backend is authoritative (it sets the
 * `large` flag on `ReadFileResponse`); this constant mirrors the Rust value
 * (`packages/service/src/domain/editor/file_size.rs::LARGE_FILE_OPEN_BYTES`)
 * and is used as a defensive fallback for older services. Keep the two in sync.
 */
export const LARGE_FILE_OPEN_BYTES = 1_000_000;

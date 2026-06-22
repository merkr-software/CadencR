/**
 * Coarse LSP state for the editor status bar. Extracted so both `useLsp` and
 * `useLspClients` share one type without a circular import.
 *
 * - `unsupported`: no language server is registered for this file's extension.
 * - `starting`: session reserved / WebSocket negotiating / server booting.
 * - `ready`: client + workspace are live; LSP requests succeed.
 * - `reconnecting`: the socket died unexpectedly and the manager is rebuilding
 *   the session with backoff.
 * - `error`: session-open or transport failure (or reconnect gave up).
 *
 * @public
 */
export type LspStatus = "unsupported" | "starting" | "ready" | "reconnecting" | "error";

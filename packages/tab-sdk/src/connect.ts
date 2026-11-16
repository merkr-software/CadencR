import { CadencrClient } from "./client.js";
import { CadencrError, toCadencrError } from "./errors.js";
import { setDefaultClient } from "./fetcher.js";
import { toPortSource, type PortSource } from "./transport.js";

export interface ConnectOptions {
  /** How long to wait for the host port and the `hello` reply. Default 10 s. */
  timeoutMs?: number;
  /** Default per-request timeout. Default 30 s. */
  requestTimeoutMs?: number;
  /** Write the theme onto `<html>` (`--cadencr-*`, `data-appearance`,
   *  `color-scheme`) now and on every change. Default `true`. */
  applyTheme?: boolean;
  /** Where the port comes from. Default: the window message the Cadencr
   *  preload posts. Tests pass `createTestHost().transport` or a port. */
  transport?: PortSource | MessagePort;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Connects to the Cadencr host and performs the `hello` handshake. Rejects
 * with a `CadencrError`: `PLUGIN_API_UNSUPPORTED` when the host speaks no
 * common API version, `TIMEOUT` when no host answers (the page is not running
 * inside a Cadencr custom tab).
 */
export async function connect(options: ConnectOptions = {}): Promise<CadencrClient> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const client = new CadencrClient({
    source: toPortSource(options.transport),
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    handshakeTimeoutMs: timeoutMs,
    applyTheme: options.applyTheme ?? true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new CadencrError(
          "TIMEOUT",
          `No Cadencr host answered within ${timeoutMs} ms — is this page running inside a Cadencr custom tab?`,
        ),
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([client.start(), timeout]);
  } catch (error) {
    client.close();
    throw toCadencrError(error);
  } finally {
    clearTimeout(timer);
  }
  setDefaultClient(client);
  return client;
}

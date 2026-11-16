import { CadencrError } from "./errors.js";
import type { ExecRunResult, JsonValue } from "./protocol.js";
import type { Requester } from "./requester.js";

export interface ExecRunOptions {
  /** 1 ms – 120 s; 30 s when omitted. */
  timeoutMs?: number;
}

/** Runs the programs listed in `tab.json` `commands` (docs/CUSTOM_TABS.md §4.6). */
export interface CadencrExec {
  /**
   * Run `program` with `args` in the conversation's folder, without a shell.
   * Resolves for any exit status; rejects when the program is not listed
   * (`PLUGIN_EXEC_DENIED`), not installed, too slow or too chatty.
   */
  run(program: string, args?: string[], options?: ExecRunOptions): Promise<ExecRunResult>;
}

export interface BackendRequestOptions {
  /** 1 ms – 120 s; 30 s when omitted. */
  timeoutMs?: number;
}

/** Talks to the tab's native `backend` (docs/CUSTOM_TABS.md §4.7). */
export interface CadencrBackend {
  /**
   * Send `method` to the backend, which Cadencr starts on the first call.
   * Resolves the backend's `result` — JSON the SDK does not check, typed as
   * `T` — and an `error` it answers rejects with a `CadencrError` carrying the
   * backend's own code.
   */
  request<T = JsonValue>(
    method: string,
    params?: JsonValue,
    options?: BackendRequestOptions,
  ): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Room for the hop through the host beyond the service's own timeout. */
const HOST_MARGIN_MS = 5_000;

export function createExec(send: Requester): CadencrExec {
  return {
    run: (program, args = [], options = {}) =>
      send(
        "exec.run",
        { program, args, timeoutMs: options.timeoutMs },
        (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + HOST_MARGIN_MS,
      ),
  };
}

export function createBackend(send: Requester): CadencrBackend {
  return {
    async request<T>(
      method: string,
      params?: JsonValue,
      options: BackendRequestOptions = {},
    ): Promise<T> {
      const answer = await send(
        "backend.request",
        { method, params, timeoutMs: options.timeoutMs },
        (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + HOST_MARGIN_MS,
      );
      if (answer.error) throw new CadencrError(answer.error.code, answer.error.message);
      return (answer.result ?? null) as T;
    },
  };
}

import { CadencrError } from "./errors.js";

/** A buffered HTTP response (from `api.request` or `net.fetch`). Body readers
 *  mirror `fetch`'s `Response` and can be called more than once. */
export interface ApiResponse {
  readonly status: number;
  /** `200`–`299`. Non-2xx responses resolve; only transport failures reject. */
  readonly ok: boolean;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function parseJson<T>(source: string, status: number): T {
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new CadencrError("HOST_ERROR", "The response body is not valid JSON", {
      status,
      details: { body: source.slice(0, 2048) },
      cause: error,
    });
  }
}

export function createApiResponse(wire: {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
}): ApiResponse {
  const body = wire.body ?? new ArrayBuffer(0);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(wire.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  const text = () => new TextDecoder().decode(body);
  return {
    status: wire.status,
    ok: wire.status >= 200 && wire.status < 300,
    headers,
    async json<T>() {
      return parseJson<T>(text(), wire.status);
    },
    async text() {
      return text();
    },
    async arrayBuffer() {
      return body.slice(0);
    },
  };
}

const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  404: "NOT_FOUND",
  408: "TIMEOUT",
};

/** Maps a non-2xx service response to a `CadencrError`, preferring the
 *  service's own `{error, code}` body. */
async function errorFromResponse(response: ApiResponse): Promise<CadencrError> {
  const source = await response.text();
  let body: unknown;
  try {
    body = source === "" ? null : JSON.parse(source);
  } catch {
    // Not JSON: keep the raw text as the error details below.
    body = source;
  }
  const parsed = (typeof body === "object" && body !== null ? body : {}) as {
    error?: unknown;
    code?: unknown;
  };
  const code =
    typeof parsed.code === "string" ? parsed.code : (STATUS_CODES[response.status] ?? "HOST_ERROR");
  const message =
    typeof parsed.error === "string" ? parsed.error : `Request failed with HTTP ${response.status}`;
  return new CadencrError(code, message, { status: response.status, details: { body } });
}

/** Resolves the JSON body of a 2xx response (`undefined` when empty) or throws
 *  the mapped error. */
export async function readJsonBody<T>(response: ApiResponse): Promise<T> {
  if (!response.ok) throw await errorFromResponse(response);
  // Decode once; `arrayBuffer()` would copy the whole body just to test emptiness.
  const source = await response.text();
  if (source === "") return undefined as T;
  return parseJson<T>(source, response.status);
}

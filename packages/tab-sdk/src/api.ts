import type { HttpMethod } from "./protocol.js";
import type { Requester } from "./requester.js";
import { createApiResponse, readJsonBody, type ApiResponse } from "./response.js";

export type QueryValue = string | number | boolean | null | undefined;

export interface ApiRequest {
  method: HttpMethod;
  /** Service path, e.g. `/api/features/12`. */
  path: string;
  /** `null`/`undefined` values are dropped. */
  query?: Record<string, QueryValue>;
  /** Any JSON-serializable value; sent as JSON. */
  body?: unknown;
  timeoutMs?: number;
}

export interface ApiCallOptions {
  query?: Record<string, QueryValue>;
  timeoutMs?: number;
}

/** The plugin surface of the Cadencr service, reached through the host. */
export interface CadencrApi {
  /** The transport: resolves for every HTTP status. */
  request(request: ApiRequest): Promise<ApiResponse>;
  /** JSON helpers: resolve the parsed body, throw `CadencrError` on non-2xx
   *  with the service's `{error, code}`. */
  get<T = unknown>(path: string, options?: ApiCallOptions): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, options?: ApiCallOptions): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, options?: ApiCallOptions): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, options?: ApiCallOptions): Promise<T>;
  delete<T = unknown>(path: string, options?: ApiCallOptions): Promise<T>;
}

function encodeQuery(
  query: Record<string, QueryValue> | undefined,
): Record<string, string> | undefined {
  if (!query) return undefined;
  const encoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) encoded[key] = String(value);
  }
  return encoded;
}

export function createApi(send: Requester): CadencrApi {
  const request = async ({ method, path, query, body, timeoutMs }: ApiRequest) => {
    const wire = await send(
      "api.request",
      {
        method,
        path,
        query: encodeQuery(query),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      timeoutMs,
    );
    return createApiResponse(wire);
  };
  const call = async <T>(
    method: HttpMethod,
    path: string,
    body: unknown,
    options: ApiCallOptions = {},
  ): Promise<T> =>
    readJsonBody<T>(
      await request({ method, path, body, query: options.query, timeoutMs: options.timeoutMs }),
    );
  return {
    request,
    get: (path, options) => call("GET", path, undefined, options),
    post: (path, body, options) => call("POST", path, body, options),
    put: (path, body, options) => call("PUT", path, body, options),
    patch: (path, body, options) => call("PATCH", path, body, options),
    delete: (path, options) => call("DELETE", path, undefined, options),
  };
}

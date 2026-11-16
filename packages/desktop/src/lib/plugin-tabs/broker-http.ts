import { resolveApiBaseUrlSync } from "@/api/client";

import { BrokerError, badRequest, errorFromResponse, toBrokerError } from "./broker-errors";
import { PLUGIN_TOKEN_HEADER, type GrantHolder } from "./broker-grant";

/** The routes a tab reaches as itself (plugin token). */
export const SELF = "/api/plugin-tabs/self";
/**
 * Largest body a guest may hand to `api.request` / `net.fetch`: the service's
 * default request-body limit. Refused here, before the renderer copies it.
 */
export const MAX_RELAY_BODY_BYTES = 2 * 1024 * 1024;
/**
 * `value` as JSON text, refused unless it is JSON and fits `maxBytes` (UTF-8).
 * One `JSON.stringify` is both the JSON check and the size source; the string
 * is only encoded when its length cannot settle the size on its own.
 */
export function jsonText(value: unknown, maxBytes: number, method: string): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw badRequest(`${method}: the value is not JSON (${String(error)})`);
  }
  if (text === undefined) throw badRequest(`${method}: the value is not JSON`);
  const tooLarge =
    text.length > maxBytes ||
    (text.length * 3 > maxBytes && new TextEncoder().encode(text).byteLength > maxBytes);
  if (tooLarge) throw badRequest(`${method}: the value is over ${maxBytes / 1024} KiB of JSON`);
  return text;
}

/** Service JSON (config, storage values, relay envelopes) — never `api.request` bodies. */
export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new BrokerError("HOST_ERROR", "The service answered with invalid JSON");
  }
}

export interface PluginHttpRequest {
  method: string;
  /** Service path starting with `/api/`. */
  path: string;
  query?: Record<string, string>;
  /** Extra request headers (never the token: that one is set here). */
  headers?: Record<string, string>;
  body?: BodyInit;
  contentType?: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Requests to the service authenticated with the instance's grant. */
export interface PluginHttp {
  /** Resolves every HTTP status; rejects only on transport failure. */
  send(request: PluginHttpRequest): Promise<Response>;
  /** `send`, but a non-2xx status rejects with the service's error. */
  sendOk(request: PluginHttpRequest): Promise<Response>;
}

function urlOf(baseUrl: string, path: string, query?: Record<string, string>): string {
  const search = query ? new URLSearchParams(query).toString() : "";
  return search === "" ? `${baseUrl}${path}` : `${baseUrl}${path}?${search}`;
}

export function createPluginHttp(
  grant: GrantHolder,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  baseUrl: () => string = resolveApiBaseUrlSync,
): PluginHttp {
  const attempt = async (request: PluginHttpRequest, token: string): Promise<Response> => {
    const headers: Record<string, string> = { ...request.headers, [PLUGIN_TOKEN_HEADER]: token };
    if (request.contentType) headers["content-type"] = request.contentType;
    try {
      return await fetchImpl(urlOf(baseUrl(), request.path, request.query), {
        method: request.method,
        headers,
        body: request.body,
      });
    } catch (error) {
      // `fetch` rejects with a TypeError when the service cannot be reached.
      if (error instanceof TypeError) throw new BrokerError("DISCONNECTED", error.message);
      throw toBrokerError(error);
    }
  };
  const send = async (request: PluginHttpRequest): Promise<Response> => {
    const token = await grant.token();
    const response = await attempt(request, token);
    if (response.status !== 401) return response;
    // The grant was revoked (manifest change, disable) or expired early:
    // re-mint once and retry. A second 401 is the answer.
    grant.invalidate(token);
    return attempt(request, await grant.token());
  };
  return {
    send,
    async sendOk(request) {
      const response = await send(request);
      if (!response.ok) throw await errorFromResponse(response);
      return response;
    },
  };
}

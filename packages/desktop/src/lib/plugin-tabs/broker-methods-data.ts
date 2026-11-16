import { z } from "zod";

import { BrokerError, badRequest, errorFromResponse, unexpectedShape } from "./broker-errors";
import { MAX_RELAY_BODY_BYTES, SELF, jsonText, readJson } from "./broker-http";
import {
  NULL_OUTCOME,
  parseParams,
  type BrokerRuntime,
  type MethodHandler,
  type MethodOutcome,
} from "./broker-runtime";
import { readInstanceState, writeInstanceState } from "./runtime-store";

/** `state.set` cap (§7): 1 MiB of serialized JSON per instance. */
const MAX_INSTANCE_STATE_BYTES = 1024 * 1024;
/** Cap of the `x-cadencr-net-headers` request header (§4.5). */
const MAX_NET_HEADERS_CHARS = 16 * 1024;
const NET_STATUS_HEADER = "x-cadencr-net-status";
const NET_HEADERS_HEADER = "x-cadencr-net-headers";
const STORAGE_NOT_FOUND = "PLUGIN_TAB_STORAGE_NOT_FOUND";

/**
 * A service path the WHATWG parser leaves exactly as written: under `/api/`,
 * no query/fragment, no `.`/`..` segment — also not one smuggled as `%2e` or
 * `\`, which the parser would resolve before `fetch` sends it.
 */
function isServicePath(path: string): boolean {
  if (!path.startsWith("/api/") || /[?#\s\\]/.test(path) || /%2e/i.test(path)) return false;
  return new URL(path, "http://service.invalid").pathname === path;
}

const apiRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z
    .string()
    .refine(isServicePath, "must be a service path under /api/, without a query or '..'"),
  query: z.record(z.string(), z.string()).optional(),
  body: z.string().max(MAX_RELAY_BODY_BYTES, "body is too large").optional(),
});

const keySchema = z.object({ key: z.string().min(1).max(128) });

const netFetchSchema = z.object({
  url: z.string().min(1),
  method: z.string().min(1).max(16).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z
    .instanceof(ArrayBuffer)
    .refine((body) => body.byteLength <= MAX_RELAY_BODY_BYTES, "body is too large")
    .optional(),
});

const netHeadersSchema = z.record(z.string(), z.string());

function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
}

async function apiRequest(params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  const request = parseParams(apiRequestSchema, params, "api.request");
  const response = await runtime.http.send({
    method: request.method,
    path: request.path,
    query: request.query,
    body: request.body,
    contentType: request.body === undefined ? undefined : "application/json",
  });
  // Bytes go to the guest untouched (and transferred, not copied): the
  // renderer never parses plugin payloads.
  const body = response.status === 204 ? null : await response.arrayBuffer();
  return {
    result: { status: response.status, headers: headersOf(response), body },
    transfer: body ? [body] : undefined,
  };
}

function storagePath(key: string): string {
  return `${SELF}/storage/${encodeURIComponent(key)}`;
}

/** A missing key reads as `null` / deletes as a no-op; anything else is an error. */
async function missingKeyOrThrow(response: Response): Promise<null> {
  const error = await errorFromResponse(response);
  if (response.status === 404 && error.code === STORAGE_NOT_FOUND) return null;
  throw error;
}

async function storageGet(params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  const { key } = parseParams(keySchema, params, "storage.get");
  const response = await runtime.http.send({ method: "GET", path: storagePath(key) });
  if (!response.ok) return { result: await missingKeyOrThrow(response) };
  return { result: await readJson(response) };
}

async function storageSet(params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  const { key, value } = parseParams(
    keySchema.extend({ value: z.unknown() }),
    params,
    "storage.set",
  );
  await runtime.http.sendOk({
    method: "PUT",
    path: storagePath(key),
    // The service enforces its own (smaller) per-value cap with a stable code.
    body: jsonText(value, MAX_RELAY_BODY_BYTES, "storage.set"),
    contentType: "application/json",
  });
  return NULL_OUTCOME;
}

async function storageDelete(params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  const { key } = parseParams(keySchema, params, "storage.delete");
  const response = await runtime.http.send({ method: "DELETE", path: storagePath(key) });
  if (!response.ok) await missingKeyOrThrow(response);
  return NULL_OUTCOME;
}

async function storageList(_params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  const response = await runtime.http.sendOk({ method: "GET", path: `${SELF}/storage` });
  const keys = z.array(z.string()).safeParse(await readJson(response));
  if (!keys.success) {
    throw unexpectedShape("storage.list");
  }
  return { result: keys.data };
}

async function configGet(_params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  const response = await runtime.http.sendOk({ method: "GET", path: `${SELF}/configuration` });
  const body = await readJson(response);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw unexpectedShape("config.get");
  }
  return { result: body };
}

/** The upstream answer the relay carried in its `x-cadencr-net-*` headers (§4.5). */
function relayedHead(response: Response): { status: number; headers: Record<string, string> } {
  const status = Number(response.headers.get(NET_STATUS_HEADER));
  let headers: unknown;
  try {
    headers = JSON.parse(response.headers.get(NET_HEADERS_HEADER) ?? "{}");
  } catch {
    headers = null;
  }
  const parsed = netHeadersSchema.safeParse(headers);
  if (!Number.isInteger(status) || status < 100 || status > 599 || !parsed.success) {
    throw unexpectedShape("net.fetch");
  }
  return { status, headers: parsed.data };
}

/**
 * Raw bytes both ways (§4.5): the request body goes out as is, with the
 * target in the query and its headers in one small JSON header; the upstream
 * body comes back as the response body and is transferred to the guest.
 * Nothing here encodes, decodes or parses the payload.
 */
async function netFetch(params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  const request = parseParams(netFetchSchema, params, "net.fetch");
  if (runtime.plugin.allowedOrigins.length === 0) {
    throw new BrokerError(
      "PLUGIN_NETWORK_DENIED",
      "This tab declares no network.allowed_origins in tab.json",
    );
  }
  const headers = request.headers ? asciiJson(request.headers) : undefined;
  if (headers !== undefined && headers.length > MAX_NET_HEADERS_CHARS) {
    throw badRequest(`net.fetch headers are over ${MAX_NET_HEADERS_CHARS / 1024} KiB`);
  }
  const response = await runtime.http.send({
    method: "POST",
    path: `${SELF}/net/fetch`,
    query: { url: request.url, method: request.method ?? "GET" },
    headers: headers === undefined ? undefined : { [NET_HEADERS_HEADER]: headers },
    body: request.body,
    contentType: "application/octet-stream",
  });
  // A relay failure (denied origin, timeout, too large) is the service's own
  // `{error, code}`, without the upstream status header.
  if (!response.ok || !response.headers.has(NET_STATUS_HEADER)) {
    throw await errorFromResponse(response);
  }
  const head = relayedHead(response);
  const body = await response.arrayBuffer();
  return { result: { ...head, body }, transfer: [body] };
}

/**
 * JSON that is a valid header value: `JSON.stringify` keeps non-ASCII as is,
 * which `fetch` refuses in a header, so every code unit past `~` becomes a
 * `\uXXXX` escape the service's JSON parser reads back.
 */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function stateGet(_params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  return { result: readInstanceState(runtime.instanceId) };
}

async function stateSet(params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  const { value } = parseParams(z.object({ value: z.unknown() }), params, "state.set");
  writeInstanceState(runtime.instanceId, jsonText(value, MAX_INSTANCE_STATE_BYTES, "state.set"));
  return NULL_OUTCOME;
}

export const DATA_METHODS: Readonly<Record<string, MethodHandler>> = {
  "api.request": apiRequest,
  "storage.get": storageGet,
  "storage.set": storageSet,
  "storage.delete": storageDelete,
  "storage.list": storageList,
  "config.get": configGet,
  "net.fetch": netFetch,
  "state.get": stateGet,
  "state.set": stateSet,
};

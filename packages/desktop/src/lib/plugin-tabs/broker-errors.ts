import { isAxiosError } from "axios";
import type { WireError } from "@cadencr/tab-sdk/protocol";

import { isApiErrorBody } from "@/lib/api-errors";

/**
 * A failure the broker answers a guest request with. `code` is a protocol
 * code (docs/CUSTOM_TABS.md §7) or, for a relayed service error, the
 * service's own stable `code`.
 */
export class BrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "CAPABILITY_DENIED",
  403: "PLUGIN_SCOPE_DENIED",
  404: "NOT_FOUND",
  408: "TIMEOUT",
  413: "BAD_REQUEST",
  422: "BAD_REQUEST",
  504: "TIMEOUT",
};

/** Protocol code for an HTTP status the service answered without a `code`. */
export function codeForStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? "HOST_ERROR";
}

/** `{error, code}` (the service's one error shape) out of any parsed body. */
function serviceErrorFields(body: unknown): { code?: string; message?: string } {
  if (!isApiErrorBody(body)) return {};
  const { code, error } = body;
  return {
    code: typeof code === "string" && code.length > 0 ? code : undefined,
    message: typeof error === "string" && error.length > 0 ? error : undefined,
  };
}

function errorFromServiceBody(status: number, body: unknown): BrokerError {
  const { code, message } = serviceErrorFields(body);
  return new BrokerError(code ?? codeForStatus(status), message ?? `HTTP ${status}`, { status });
}

/**
 * The error a non-2xx service response stands for. Reads the body as text:
 * service error bodies are small `{error, code}` documents, never plugin data.
 */
export async function errorFromResponse(response: Response): Promise<BrokerError> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    // A proxy or crash page, not the service's JSON: the status still maps.
    body = null;
  }
  return errorFromServiceBody(response.status, body);
}

/** The error an axios call to the service failed with (grant minting). */
export function errorFromAxios(error: unknown): BrokerError {
  if (error instanceof BrokerError) return error;
  if (isAxiosError(error)) {
    if (!error.response) {
      return new BrokerError("DISCONNECTED", error.message || "The service is unreachable");
    }
    return errorFromServiceBody(error.response.status, error.response.data);
  }
  return toBrokerError(error);
}

/** Any thrown value as a `BrokerError` (unknown failures become `HOST_ERROR`). */
export function toBrokerError(error: unknown): BrokerError {
  if (error instanceof BrokerError) return error;
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new BrokerError("TIMEOUT", error.message);
    }
    return new BrokerError("HOST_ERROR", error.message);
  }
  return new BrokerError("HOST_ERROR", String(error));
}

export function toWireError(error: unknown): WireError {
  const failure = toBrokerError(error);
  return failure.details === undefined
    ? { code: failure.code, message: failure.message }
    : { code: failure.code, message: failure.message, details: failure.details };
}

export function badRequest(message: string): BrokerError {
  return new BrokerError("BAD_REQUEST", message);
}

/** The service answered `method` with a body the broker does not recognize. */
export function unexpectedShape(method: string): BrokerError {
  return new BrokerError("HOST_ERROR", `The service answered ${method} with an unexpected shape`);
}

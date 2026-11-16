import type { CadencrErrorCode, WireError } from "./protocol.js";

/** Every failure the SDK reports. `code` is a protocol code
 *  (`PLUGIN_SCOPE_DENIED`, `TIMEOUT`, …) or, for `api.*` helpers, the stable
 *  code from the service's `{error, code}` body. */
export class CadencrError extends Error {
  readonly code: CadencrErrorCode | (string & {});
  readonly details?: unknown;
  /** HTTP status when the error comes from a service response. */
  readonly status?: number;

  constructor(
    code: CadencrErrorCode | (string & {}),
    message: string,
    options: { details?: unknown; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CadencrError";
    this.code = code;
    this.details = options.details;
    this.status = options.status;
  }

  static fromWire(error: WireError): CadencrError {
    return new CadencrError(error.code, error.message, { details: error.details });
  }

  toWire(): WireError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isCadencrError(value: unknown): value is CadencrError {
  return value instanceof CadencrError;
}

/** Normalizes anything thrown into a `CadencrError` (unknown failures become
 *  `HOST_ERROR`). */
export function toCadencrError(value: unknown): CadencrError {
  if (value instanceof CadencrError) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new CadencrError("HOST_ERROR", message, { cause: value });
}

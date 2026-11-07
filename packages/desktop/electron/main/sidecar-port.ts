/**
 * The packaged service's fixed loopback port. The sidecar binds it and the
 * renderer CSP allows it, so both read this one constant.
 */
export const SIDECAR_PORT = 5004;

export const SIDECAR_BASE_URL = `http://127.0.0.1:${SIDECAR_PORT}`;

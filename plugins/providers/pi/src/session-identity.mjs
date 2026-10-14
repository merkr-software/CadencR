import { isAbsolute, resolve } from "node:path";

const SESSION_ID_PREFIX = "pi-cadencr-v1.";

export function normalizeWorkspace(cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error("Pi session workspace must be an absolute path");
  }
  return resolve(cwd);
}

export function encodeSessionId(cwd, nativeSessionId) {
  if (typeof nativeSessionId !== "string" || nativeSessionId.length === 0) {
    throw new Error("Pi returned no RPC session ID");
  }
  const payload = JSON.stringify([normalizeWorkspace(cwd), nativeSessionId]);
  return `${SESSION_ID_PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

export function decodeSessionId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.startsWith(SESSION_ID_PREFIX)) {
    throw new Error(
      "Pi session ID is not workspace-bound; start a new conversation with this connector version",
    );
  }
  try {
    const payload = JSON.parse(
      Buffer.from(sessionId.slice(SESSION_ID_PREFIX.length), "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(payload) ||
      payload.length !== 2 ||
      typeof payload[0] !== "string" ||
      typeof payload[1] !== "string" ||
      payload[1].length === 0
    ) {
      throw new Error("invalid payload");
    }
    const decoded = { cwd: normalizeWorkspace(payload[0]), nativeSessionId: payload[1] };
    if (encodeSessionId(decoded.cwd, decoded.nativeSessionId) !== sessionId) {
      throw new Error("non-canonical payload");
    }
    return decoded;
  } catch (error) {
    throw new Error(`Pi session ID is invalid: ${error.message}`);
  }
}

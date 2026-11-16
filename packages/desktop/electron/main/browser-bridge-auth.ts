import crypto from "node:crypto";

/**
 * Who called the Browser bridge. The service holds the launch token and may
 * act on any feature (archive cleanup closes a feature's tabs). A Browser MCP
 * subprocess only holds a token derived for the feature it is pinned to, and
 * may only act there: its environment is readable by the agent it serves.
 *
 * Mirrors `packages/service/src/domain/mcp/tools/browser_bridge_scope.rs`:
 * `fb1.<feature_id>.<base64url(HMAC-SHA256(launch token, "cadencr-browser-bridge/feature/<feature_id>"))>`.
 */
export type BrowserBridgeCaller = { kind: "service" } | { kind: "feature"; featureId: number };

const FEATURE_TOKEN = /^fb1\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

export function featureBridgeToken(launchToken: string, featureId: number): string {
  const signature = crypto
    .createHmac("sha256", launchToken)
    .update(`cadencr-browser-bridge/feature/${featureId}`)
    .digest("base64url");
  return `fb1.${featureId}.${signature}`;
}

/** The caller behind an `Authorization` header, or `null` when it is not one. */
export function authenticateBridgeCaller(
  authorization: string,
  launchToken: string,
): BrowserBridgeCaller | null {
  const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (presented === null) return null;
  if (sameSecret(presented, launchToken)) return { kind: "service" };
  const match = FEATURE_TOKEN.exec(presented);
  if (!match) return null;
  const featureId = Number(match[1]);
  return sameSecret(presented, featureBridgeToken(launchToken, featureId))
    ? { kind: "feature", featureId }
    : null;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

import type { RuntimeConfig } from "../runtime-config";
import { isOwnPluginTabUrl } from "./plugin-tab-ids";

/**
 * The policy the service sets on every asset (docs/CUSTOM_TABS.md §5.2). The
 * relay re-applies it when an upstream response lacks one, so a service bug can
 * never hand a guest a document without `connect-src 'none'`.
 */
export const PLUGIN_TAB_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// Only these upstream headers reach the guest. `content-encoding` /
// `content-length` are deliberately dropped: fetch has already decoded the body.
const FORWARDED_HEADERS = [
  "content-type",
  "content-security-policy",
  "x-content-type-options",
  "cache-control",
  "etag",
  "last-modified",
];

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export interface PluginTabAssetRelayDeps {
  getConfig: () => RuntimeConfig;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}

export type PluginTabAssetHandler = (request: Request) => Promise<Response>;

function plain(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...extra },
  });
}

function assetUrl(config: RuntimeConfig, pluginId: string, url: URL): string {
  // Chromium has already canonicalized the path of a standard-scheme URL (dot
  // segments resolved, unsafe bytes percent-encoded); it is forwarded verbatim
  // and the service resolves it under the plugin folder with realpath
  // containment. An empty path asks for the manifest `entry`.
  const path = url.pathname.replace(/^\/+/, "");
  return `${config.baseUrl}/api/plugin-tabs/${encodeURIComponent(pluginId)}/assets/${path}`;
}

function relayedHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (!headers.has("content-security-policy"))
    headers.set("content-security-policy", PLUGIN_TAB_CSP);
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

/**
 * `protocol.handle("cadencr-tab")` handler for one plugin's partition. Serves
 * only `cadencr-tab://<pluginId>/…` GETs by relaying them to the service's
 * `GET /api/plugin-tabs/{id}/assets/{*path}` with the main token, streaming the
 * body back. Any other host is 403, any other method 405, an unreachable
 * service 502 (which the guest view reports as a failed load).
 */
export function createPluginTabAssetHandler(
  pluginId: string,
  deps: PluginTabAssetRelayDeps,
): PluginTabAssetHandler {
  return async (request) => {
    // Same origin gate as the navigation and request guards; a malformed URL
    // is not one of the plugin's own either.
    if (!isOwnPluginTabUrl(request.url, pluginId)) {
      return plain(403, "This custom tab may only load its own assets.");
    }
    const url = new URL(request.url);
    if (request.method !== "GET") return plain(405, "Method not allowed.", { allow: "GET" });

    const config = deps.getConfig();
    const headers: Record<string, string> = {};
    if (config.authToken) headers["x-cadencr-token"] = config.authToken;
    let upstream: Response;
    try {
      upstream = await deps.fetch(assetUrl(config, pluginId, url), { headers, redirect: "manual" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return plain(502, `Cadencr could not reach its service: ${message}`);
    }
    const body = NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body;
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: relayedHeaders(upstream),
    });
  };
}

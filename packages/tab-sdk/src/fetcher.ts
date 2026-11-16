import type { CadencrClient } from "./client.js";
import { CadencrError } from "./errors.js";
import type { HttpMethod } from "./protocol.js";
import { createApiResponse, readJsonBody } from "./response.js";

/**
 * The seam for the generated, typed client of the plugin API surface: an
 * orval `fetch` client with a custom mutator calls this with a service URL
 * (`/api/…?query`) and a `RequestInit`. Resolves the parsed JSON body;
 * throws `CadencrError` on non-2xx.
 */
export type PluginFetch = <T>(url: string, init?: RequestInit) => Promise<T>;

const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

type CallClient = Pick<CadencrClient, "call">;

/**
 * Open clients, most recently connected last. `pluginFetch` serves through the
 * last one; closing it falls back to the previous one still open. A single
 * slot would break under React StrictMode, whose double mount connects twice
 * and then closes the *first* client — possibly after the second one won.
 */
const openClients: CallClient[] = [];

/** @internal `connect()` registers its client for `pluginFetch`. */
export function setDefaultClient(client: CallClient): void {
  releaseDefaultClient(client);
  openClients.push(client);
}

/** @internal A closed client stops serving `pluginFetch`. */
export function releaseDefaultClient(client: CallClient): void {
  const index = openClients.indexOf(client);
  if (index !== -1) openClients.splice(index, 1);
}

function bodyText(body: RequestInit["body"]): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  throw new CadencrError("BAD_REQUEST", "Plugin API request bodies must be JSON strings");
}

/** Builds a `PluginFetch` bound to one client. */
export function createPluginFetch(client: CallClient): PluginFetch {
  return async <T>(url: string, init: RequestInit = {}): Promise<T> => {
    const parsed = new URL(url, "http://cadencr.invalid");
    const method = (init.method ?? "GET").toUpperCase() as HttpMethod;
    if (!HTTP_METHODS.includes(method)) {
      throw new CadencrError("BAD_REQUEST", `Unsupported HTTP method ${method}`);
    }
    const wire = await client.call("api.request", {
      method,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      body: bodyText(init.body),
    });
    return readJsonBody<T>(createApiResponse(wire));
  };
}

/** `PluginFetch` bound to the client of the latest successful `connect()`. */
export const pluginFetch: PluginFetch = async <T>(url: string, init?: RequestInit) => {
  const client = openClients.at(-1);
  if (!client) {
    throw new CadencrError("DISCONNECTED", "Call connect() before using the plugin API client");
  }
  return createPluginFetch(client)<T>(url, init);
};

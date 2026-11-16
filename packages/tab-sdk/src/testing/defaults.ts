import { CadencrError } from "../errors.js";
import {
  negotiateApiVersion,
  type ApiRequestParams,
  type ApiVersionRange,
  type JsonValue,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type TabContext,
  type ThemeSnapshot,
  type WireHttpResponse,
} from "../protocol.js";
import { jsonResponse } from "./fixtures.js";

/** The fake host's mutable state, shared with its default handlers. */
export interface HostState {
  context: TabContext;
  theme: ThemeSnapshot;
  capabilities: string[];
  visible: boolean;
  shortcuts: string[];
  instanceId: string;
  plugin: { id: string; version: string };
  apiVersions: ApiVersionRange;
  config: Record<string, unknown>;
  storage: Map<string, JsonValue>;
  instanceState: { value: JsonValue };
  badge: string | null;
  routes: Map<string, (request: ApiRequestParams) => WireHttpResponse | Promise<WireHttpResponse>>;
  subscriptions: Map<string, { topic: string; params?: Record<string, unknown> }>;
  seqs: Map<string, number>;
  subscriptionCounter: number;
}

type Handlers = {
  [M in MethodName]: (params: MethodParams<M>) => MethodResult<M> | Promise<MethodResult<M>>;
};

/** Sensible answers for every method: in-memory storage/state, routed
 *  `api.request`, recorded subscriptions, denied `net.fetch`, `exec.run` and
 *  `backend.request` (a test installs a handler with `host.handle`). */
export function createDefaultHandlers(state: HostState): Handlers {
  return {
    hello: ({ apiVersions }) => {
      const apiVersion = negotiateApiVersion(apiVersions, state.apiVersions);
      if (apiVersion === null) {
        throw new CadencrError(
          "PLUGIN_API_UNSUPPORTED",
          `Host speaks API v${state.apiVersions[0]}–v${state.apiVersions[1]}`,
        );
      }
      return {
        apiVersion,
        instanceId: state.instanceId,
        plugin: state.plugin,
        context: state.context,
        theme: state.theme,
        capabilities: state.capabilities,
        visible: state.visible,
        shortcuts: state.shortcuts,
      };
    },
    "api.request": (request) => {
      const route = state.routes.get(`${request.method} ${request.path}`);
      if (route) return route(request);
      return jsonResponse(404, {
        error: `No test route for ${request.method} ${request.path}`,
        code: "NOT_FOUND",
      });
    },
    "streams.subscribe": ({ topic, params }) => {
      const subscriptionId = `sub-${++state.subscriptionCounter}`;
      state.subscriptions.set(subscriptionId, { topic, params });
      return { subscriptionId };
    },
    "streams.unsubscribe": ({ subscriptionId }) => {
      state.subscriptions.delete(subscriptionId);
      state.seqs.delete(subscriptionId);
      return null;
    },
    "storage.get": ({ key }) => state.storage.get(key) ?? null,
    "storage.set": ({ key, value }) => {
      state.storage.set(key, value);
      return null;
    },
    "storage.delete": ({ key }) => {
      state.storage.delete(key);
      return null;
    },
    "storage.list": () => [...state.storage.keys()],
    "state.get": () => state.instanceState.value,
    "state.set": ({ value }) => {
      state.instanceState.value = value;
      return null;
    },
    "config.get": () => state.config,
    "net.fetch": ({ url }) => {
      throw new CadencrError("PLUGIN_NETWORK_DENIED", `No test handler for net.fetch ${url}`);
    },
    "exec.run": ({ program }) => {
      throw new CadencrError("PLUGIN_EXEC_DENIED", `No test handler for exec.run ${program}`);
    },
    "backend.request": ({ method }) => {
      throw new CadencrError(
        "PLUGIN_BACKEND_UNDECLARED",
        `No test handler for backend.request ${method}`,
      );
    },
    "ui.toast": () => null,
    "ui.openExternal": () => null,
    "ui.setBadge": ({ text }) => {
      state.badge = text;
      return null;
    },
  };
}

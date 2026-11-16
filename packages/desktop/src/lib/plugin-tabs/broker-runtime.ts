import type { z } from "zod";

import { badRequest } from "./broker-errors";
import type { GrantHolder } from "./broker-grant";
import type { PluginHttp } from "./broker-http";
import type { PluginStreamSocket } from "./broker-streams";

/** What the broker knows about the plugin behind an instance. */
export interface PluginIdentity {
  id: string;
  name: string;
  version: string;
  allowedOrigins: readonly string[];
  /** Whether tab.json lists `commands` (`exec.run`); the service checks which. */
  hasCommands: boolean;
  /** Whether tab.json declares a `backend` (`backend.request`). */
  hasBackend: boolean;
  /** The ids of tab.json's `shortcuts` that can fire (none taken by Cadencr). */
  shortcuts: readonly string[];
}

/** Everything a method handler may use; one per broker. */
export interface BrokerRuntime {
  instanceId: string;
  plugin: PluginIdentity;
  grant: GrantHolder;
  http: PluginHttp;
  streams: PluginStreamSocket;
}

export interface MethodOutcome {
  result: unknown;
  /** Buffers moved (not copied) to the guest with the response. */
  transfer?: Transferable[];
}

export type MethodHandler = (params: unknown, runtime: BrokerRuntime) => Promise<MethodOutcome>;

export const NULL_OUTCOME: MethodOutcome = { result: null };

/** Validate guest params at the boundary; a mismatch is the guest's `BAD_REQUEST`. */
export function parseParams<T>(schema: z.ZodType<T>, params: unknown, method: string): T {
  const parsed = schema.safeParse(params ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? ` (${issue.path.join(".")})` : "";
  throw badRequest(`Invalid params for ${method}${where}: ${issue?.message ?? "unexpected shape"}`);
}

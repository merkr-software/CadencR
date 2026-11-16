import { AxiosError, AxiosHeaders, type AxiosResponse } from "axios";
import type { PluginTabPendingUpdate, PluginTabSummary, Project } from "@/api/generated";
import { pluginTabSummary } from "@/components/plugin-tabs/plugin-tab-fixtures";

/**
 * Test fixtures shared by the Custom tabs settings tests. The tab is the
 * plugin-tab fixture, before the user consented to it or switched it on.
 */
export function tabFixture(overrides: Partial<PluginTabSummary> = {}): PluginTabSummary {
  return pluginTabSummary({
    permissions: ["features:read", "git:read"],
    permissions_hash: "hash-1",
    authoring_project_id: null,
    enablement: { global: null, project: null, effective: false, consent_required: true },
    ...overrides,
  });
}

/** A staged marketplace update that adds a native backend. */
export function pendingUpdateFixture(
  overrides: Partial<PluginTabPendingUpdate> = {},
): PluginTabPendingUpdate {
  return {
    version: "0.2.0",
    permissions_hash: "hash-update",
    access_level: "backend",
    permissions: ["git:read", "workspace:read"],
    network: { allowed_origins: [], reasoning: null },
    commands: [],
    backend: {
      protocol: 1,
      binary: { "darwin-aarch64": "bin/darwin-aarch64/ports" },
      reasoning: "Lists the processes listening on local ports.",
    },
    ...overrides,
  };
}

/** An installed marketplace tab, allowed and on, with an update waiting for review. */
export function stagedUpdateTab(overrides: Partial<PluginTabSummary> = {}): PluginTabSummary {
  return tabFixture({
    managed: true,
    enablement: { global: true, project: null, effective: true, consent_required: false },
    pending_update: pendingUpdateFixture(),
    ...overrides,
  });
}

export function projectFixture(id: number, name: string): Project {
  return { id, name, path: `/code/${name}`, created_at: "2026-10-01T00:00:00Z" };
}

/** An axios error carrying the service's `{error, code}` body. */
export function serviceError(status: number, code: string, message: string): AxiosError {
  const response = {
    status,
    statusText: "",
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: { error: message, code },
  } as AxiosResponse;
  return new AxiosError(message, String(status), undefined, undefined, response);
}

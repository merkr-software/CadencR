import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customInstance } from "./client";
import { AGENT_TYPES, type AgentTypeSetting } from "../shared/models";
import type { PermissionMode } from "@/types/permission-mode";
import type { ModelCatalogEntry } from "./generated";

export type RuntimeModelOption = {
  [Key in keyof ModelCatalogEntry]: Exclude<ModelCatalogEntry[Key], null>;
};

export interface RuntimeProviderOption {
  id: string;
  label: string;
  status: "available" | "unavailable" | "coming_soon";
  status_message?: string;
  models: RuntimeModelOption[];
  modes?: RuntimeProviderModeOption[];
  default_model: string | null;
}

export interface RuntimeProviderModeOption {
  id: PermissionMode;
  label: string;
  description?: string;
}

export interface AgentCatalog {
  default_provider: string;
  providers: RuntimeProviderOption[];
}

export type ProviderSettings = Record<AgentTypeSetting, string>;

interface ProviderMutationCallbacks<TVariables> {
  onSuccess?: (_data: unknown, variables: TVariables) => void;
  onError?: (_error: unknown, variables: TVariables) => void;
}

function defaultProviderSettings(): ProviderSettings {
  return Object.fromEntries(AGENT_TYPES.map((agentType) => [agentType, ""])) as ProviderSettings;
}

interface QueryExtras {
  enabled?: boolean;
  staleTime?: number;
  cwd?: string;
  profile?: string;
}

function readQueryExtras(arg: boolean | QueryExtras | undefined): QueryExtras {
  if (arg === undefined) return {};
  if (typeof arg === "boolean") return { enabled: arg };
  return arg;
}

// The catalog is built from a CLI-detection probe that can take several seconds
// per cwd. Its result (which agents are installed, which models they expose)
// only changes when the user installs/updates a CLI or edits a profile — never
// between feature switches. So we cache each `cwd+profile` aggressively and let
// profile mutations invalidate `["agent-catalog"]` explicitly; switching back to
// an already-probed cwd then serves from cache instead of re-probing.
const AGENT_CATALOG_STALE_MS = 10 * 60_000;
const AGENT_CATALOG_CACHE_MS = 30 * 60_000;

export function useAgentCatalog(extras?: QueryExtras) {
  const { cwd, profile, ...queryExtras } = extras ?? {};
  // The Claude model probe is profile-dependent (Bedrock/Vertex expose
  // different model ids), so `profile` is part of the cache key — switching the
  // prompt-area profile selector refetches the catalog for that profile rather
  // than serving the active profile's stale models.
  return useQuery({
    queryKey: ["agent-catalog", cwd ?? null, profile ?? null],
    queryFn: () =>
      customInstance<AgentCatalog>({
        method: "GET",
        url: "/api/agent-catalog",
        params:
          cwd || profile ? { ...(cwd ? { cwd } : {}), ...(profile ? { profile } : {}) } : undefined,
      }),
    staleTime: AGENT_CATALOG_STALE_MS,
    cacheTime: AGENT_CATALOG_CACHE_MS,
    ...queryExtras,
  });
}

export function useGetWorkspaceProviderSettings(arg: boolean | QueryExtras = true) {
  const { enabled = true, staleTime } = readQueryExtras(arg);
  return useQuery({
    queryKey: ["workspace", "provider-settings"],
    queryFn: async () => {
      const data = await customInstance<ProviderSettings>({
        method: "GET",
        url: "/api/workspace/provider-settings",
      });
      return { ...defaultProviderSettings(), ...data };
    },
    enabled,
    staleTime,
  });
}

export function useSetWorkspaceProviderSetting(
  callbacks?: ProviderMutationCallbacks<{ agentType: AgentTypeSetting; providerId: string }>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentType, providerId }: { agentType: AgentTypeSetting; providerId: string }) =>
      customInstance<{ value: string }>({
        method: "PUT",
        url: "/api/workspace/provider-settings",
        data: { agent_type: agentType, provider_id: providerId },
      }),
    onSuccess: async (data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["workspace", "provider-settings"] });
      callbacks?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => callbacks?.onError?.(error, variables),
  });
}

export function useGetProjectProviderSettings(
  projectId: number,
  arg: boolean | QueryExtras = true,
) {
  const { enabled = true, staleTime } = readQueryExtras(arg);
  return useQuery({
    queryKey: ["projects", "provider-settings", projectId],
    queryFn: () =>
      customInstance<ProviderSettings>({
        method: "GET",
        url: `/api/projects/${projectId}/provider-settings`,
      }),
    enabled,
    staleTime,
  });
}

export function useSetProjectProviderSetting(
  callbacks?: ProviderMutationCallbacks<{
    projectId: number;
    providerType: AgentTypeSetting;
    provider: string;
  }>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      providerType,
      provider,
    }: {
      projectId: number;
      providerType: AgentTypeSetting;
      provider: string;
    }) =>
      customInstance<{ success: boolean }>({
        method: "PUT",
        url: `/api/projects/${projectId}/provider-settings`,
        data: { provider_type: providerType, provider },
      }),
    onSuccess: async (data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["projects", "provider-settings", variables.projectId],
      });
      callbacks?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => callbacks?.onError?.(error, variables),
  });
}

// ---------------------------------------------------------------------------
// Claude Code profiles & custom models
// ---------------------------------------------------------------------------

export const DEFAULT_CLAUDE_PROFILE_NAME = "default";

export interface ClaudeCodeProfile {
  name: string;
  env: Record<string, string>;
}

export interface ClaudeCodeProfilesResponse {
  profiles: ClaudeCodeProfile[];
  active: string;
}

export interface ClaudeCodeCustomModelsResponse {
  models: RuntimeModelOption[];
}

export function useClaudeCodeProfiles(arg: boolean | QueryExtras = true) {
  const { enabled = true, staleTime } = readQueryExtras(arg);
  return useQuery({
    queryKey: ["claude-code", "profiles"],
    queryFn: () =>
      customInstance<ClaudeCodeProfilesResponse>({
        method: "GET",
        url: "/api/claude-code/profiles",
      }),
    enabled,
    staleTime,
  });
}

// The active profile's env feeds the Claude model probe, so the agent catalog
// (and the model picker built from it) is profile-dependent — under Bedrock /
// Vertex even the model ids change. Any profile mutation that can alter the
// active env therefore invalidates the catalog so the picker refetches the
// right models, not just the profiles list.
async function invalidateProfilesAndCatalog(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["claude-code", "profiles"] }),
    queryClient.invalidateQueries({ queryKey: ["agent-catalog"] }),
  ]);
}

export function useUpsertClaudeCodeProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, env }: { name: string; env: Record<string, string> }) =>
      customInstance<ClaudeCodeProfile>({
        method: "PUT",
        url: `/api/claude-code/profiles/${encodeURIComponent(name)}`,
        data: { env },
      }),
    onSuccess: () => invalidateProfilesAndCatalog(queryClient),
  });
}

export function useDeleteClaudeCodeProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name }: { name: string }) =>
      customInstance<{ ok: boolean }>({
        method: "DELETE",
        url: `/api/claude-code/profiles/${encodeURIComponent(name)}`,
      }),
    onSuccess: () => invalidateProfilesAndCatalog(queryClient),
  });
}

export function useSetActiveClaudeCodeProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name }: { name: string }) =>
      customInstance<{ ok: boolean }>({
        method: "PUT",
        url: "/api/claude-code/profiles/active",
        data: { name },
      }),
    onSuccess: () => invalidateProfilesAndCatalog(queryClient),
  });
}

export function useClaudeCodeCustomModels() {
  return useQuery({
    queryKey: ["claude-code", "custom-models"],
    queryFn: () =>
      customInstance<ClaudeCodeCustomModelsResponse>({
        method: "GET",
        url: "/api/claude-code/custom-models",
      }),
  });
}

export function useUpsertClaudeCodeCustomModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      modelId,
      label,
      description,
    }: {
      modelId: string;
      label: string;
      description?: string;
    }) =>
      customInstance<RuntimeModelOption>({
        method: "PUT",
        url: `/api/claude-code/custom-models/${encodeURIComponent(modelId)}`,
        data: { label, description },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["claude-code", "custom-models"] }),
        queryClient.invalidateQueries({ queryKey: ["agent-catalog"] }),
      ]);
    },
  });
}

export function useDeleteClaudeCodeCustomModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ modelId }: { modelId: string }) =>
      customInstance<{ ok: boolean }>({
        method: "DELETE",
        url: `/api/claude-code/custom-models/${encodeURIComponent(modelId)}`,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["claude-code", "custom-models"] }),
        queryClient.invalidateQueries({ queryKey: ["agent-catalog"] }),
      ]);
    },
  });
}

export function useGetFeatureProviderSettings(
  featureId: number,
  arg: boolean | QueryExtras = true,
) {
  const { enabled = true, staleTime } = readQueryExtras(arg);
  return useQuery({
    queryKey: ["features", "provider-settings", featureId],
    queryFn: () =>
      customInstance<ProviderSettings>({
        method: "GET",
        url: `/api/features/${featureId}/provider-settings`,
      }),
    enabled,
    staleTime,
  });
}

export function useSetFeatureProviderSetting(
  callbacks?: ProviderMutationCallbacks<{
    featureId: number;
    providerType: AgentTypeSetting;
    provider: string;
  }>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      featureId,
      providerType,
      provider,
    }: {
      featureId: number;
      providerType: AgentTypeSetting;
      provider: string;
    }) =>
      customInstance<{ success: boolean }>({
        method: "PUT",
        url: `/api/features/${featureId}/provider-settings`,
        data: { provider_type: providerType, provider },
      }),
    onSuccess: async (data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["features", "provider-settings", variables.featureId],
      });
      callbacks?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => callbacks?.onError?.(error, variables),
  });
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customInstance } from "./client";
import { AGENT_TYPES, DEFAULT_PROVIDER, type AgentTypeSetting } from "../shared/models";
import type { PermissionMode } from "@/types/permission-mode";

export interface RuntimeModelOption {
  id: string;
  label: string;
  description?: string;
  supports_effort?: boolean;
  supported_effort_levels?: ("low" | "medium" | "high" | "xhigh" | "max")[];
  supports_adaptive_thinking?: boolean;
  supports_fast_mode?: boolean;
  supports_auto_mode?: boolean;
}

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
  return Object.fromEntries(
    AGENT_TYPES.map((agentType) => [agentType, DEFAULT_PROVIDER]),
  ) as ProviderSettings;
}

interface QueryExtras {
  enabled?: boolean;
  staleTime?: number;
  cwd?: string;
}

function readQueryExtras(arg: boolean | QueryExtras | undefined): QueryExtras {
  if (arg === undefined) return {};
  if (typeof arg === "boolean") return { enabled: arg };
  return arg;
}

export function useAgentCatalog(extras?: QueryExtras) {
  const { cwd, ...queryExtras } = extras ?? {};
  return useQuery({
    queryKey: ["agent-catalog", cwd ?? null],
    queryFn: () =>
      customInstance<AgentCatalog>({
        method: "GET",
        url: "/api/agent-catalog",
        params: cwd ? { cwd } : undefined,
      }),
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

export function useClaudeCodeProfiles() {
  return useQuery({
    queryKey: ["claude-code", "profiles"],
    queryFn: () =>
      customInstance<ClaudeCodeProfilesResponse>({
        method: "GET",
        url: "/api/claude-code/profiles",
      }),
  });
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["claude-code", "profiles"] });
    },
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["claude-code", "profiles"] });
    },
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["claude-code", "profiles"] });
    },
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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customInstance } from "./client";
import { z } from "zod";
import { getGetAgentSelectionQueryKey } from "./generated";
import { PROVIDER_IDS } from "@/lib/providers";
import { invalidateExtensionInventories } from "@/lib/agent-extensions";

const summarySchema = z.object({
  id: z.string(),
  name: z.string(),
  config_path: z.string().nullable().optional(),
  effective_home: z.string().nullable(),
  env_keys: z.array(z.string()),
  env_unset: z.array(z.string()),
  is_active: z.boolean(),
  revision: z.string(),
});
const responseSchema = z.object({
  profiles: z.array(summarySchema),
  active_profile_id: z.string().nullable(),
});
const validationSchema = z.object({
  valid: z.boolean(),
  validation_scope: z.literal("local_syntax"),
  codex_compatible: z.boolean().nullable(),
  errors: z.array(z.object({ field: z.string(), code: z.string(), message: z.string() })),
  effective_home: z.string().nullable().optional(),
  config_exists: z.boolean().nullable().optional(),
  revision: z.string().nullable().optional(),
});

export interface CodexProfileSummary {
  id: string;
  name: string;
  config_path?: string | null;
  effective_home: string | null;
  env_keys: string[];
  env_unset: string[];
  is_active: boolean;
  revision: string;
}

export interface CodexProfilesResponse {
  profiles: CodexProfileSummary[];
  active_profile_id: string | null;
}

export interface CodexProfileDraft {
  id?: string;
  name: string;
  config_path?: string | null;
  env?: Record<string, string>;
  env_unset?: string[];
  preserve_env_keys?: string[];
}

export interface CodexProfileValidation {
  valid: boolean;
  validation_scope: "local_syntax";
  codex_compatible: boolean | null;
  errors: Array<{ field: string; code: string; message: string }>;
  effective_home?: string | null;
  config_exists?: boolean | null;
  revision?: string | null;
}

const profilesKey = ["codex", "profiles"] as const;

export function useCodexProfiles() {
  return useQuery({
    queryKey: profilesKey,
    queryFn: () =>
      customInstance<unknown>({ method: "GET", url: "/api/codex/profiles" }).then((value) =>
        responseSchema.parse(value),
      ),
  });
}

async function invalidateProfileDependentQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  profileId: string | null,
  affectsActiveProfile: boolean,
): Promise<void> {
  const invalidations = [
    queryClient.invalidateQueries({ queryKey: profilesKey }),
    queryClient.invalidateQueries({ queryKey: ["agent-profiles", PROVIDER_IDS.CODEX_CLI] }),
    queryClient.invalidateQueries({
      queryKey: ["agent-catalog"],
      predicate: (query) =>
        affectsActiveProfile ||
        (query.queryKey[2] === PROVIDER_IDS.CODEX_CLI && query.queryKey[3] === profileId),
    }),
  ];
  if (affectsActiveProfile) {
    invalidations.push(queryClient.invalidateQueries({ queryKey: getGetAgentSelectionQueryKey() }));
    // The active profile picks the Codex home, and with it its skills and servers.
    invalidations.push(invalidateExtensionInventories(queryClient));
  }
  await Promise.all(invalidations);
}

export function useSaveCodexProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: CodexProfileDraft) => {
      const { id, ...data } = draft;
      return customInstance<unknown>({
        method: id ? "PUT" : "POST",
        url: id ? `/api/codex/profiles/${encodeURIComponent(id)}` : "/api/codex/profiles",
        data,
      }).then((value) => summarySchema.parse(value));
    },
    onSuccess: (profile) =>
      invalidateProfileDependentQueries(queryClient, profile.id, profile.is_active),
  });
}

export function useDeleteCodexProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      customInstance<void>({
        method: "DELETE",
        url: `/api/codex/profiles/${encodeURIComponent(id)}`,
      }),
    onMutate: (id) => {
      const cached = queryClient.getQueryData<CodexProfilesResponse>(profilesKey);
      return { wasActive: cached ? cached.active_profile_id === id : undefined };
    },
    onSuccess: (_data, id, context) =>
      invalidateProfileDependentQueries(queryClient, id, context?.wasActive !== false),
  });
}

export function useSetActiveCodexProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profileId: string | null) =>
      customInstance<unknown>({
        method: "PUT",
        url: "/api/codex/profiles/active",
        data: { profile_id: profileId },
      }).then((value) => responseSchema.parse(value)),
    onSuccess: (_response, profileId) =>
      invalidateProfileDependentQueries(queryClient, profileId, true),
  });
}

export function useValidateCodexProfile() {
  return useMutation({
    mutationFn: (draft: CodexProfileDraft) =>
      customInstance<unknown>({
        method: "POST",
        url: "/api/codex/profiles/validate",
        data: draft,
      }).then((value) => validationSchema.parse(value)),
  });
}

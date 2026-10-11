import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { z } from "zod";
import {
  getManagedThemeCatalog,
  refreshManagedThemeCatalog,
  installManagedTheme,
  updateManagedTheme,
  applyManagedTheme,
  removeManagedTheme,
  duplicateManagedTheme,
  type SignedMixedCatalog,
} from "@/api/generated";
import { getWorkspaceSettingsQueryKey } from "@/api/settings";
import {
  managedThemeEntrySchema,
  duplicateThemeResponseSchema,
  themeCatalogSchema,
  managedThemesKey,
} from "@/lib/theme-marketplace";
import { useManagedThemes } from "./useManagedThemes";
import { invalidateByUrlPrefix } from "@/lib/queryClient";

type ThemeAction =
  | { kind: "install" | "update"; id: string; version: string; index: SignedMixedCatalog }
  | { kind: "apply"; id: string }
  | { kind: "remove"; id: string; confirmFallback: boolean }
  | { kind: "duplicate"; id: string; label: string };
const catalogKey = ["marketplace", "theme-catalog"];
export function useThemeMarketplace() {
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const inventory = useStableQuery(useManagedThemes());
  const catalog = useStableQuery(
    useQuery({
      queryKey: catalogKey,
      staleTime: 60_000,
      queryFn: async ({ signal }) => {
        const response = await getManagedThemeCatalog(signal);
        themeCatalogSchema.parse(response);
        return response;
      },
    }),
  );
  const refresh = useStableMutation(
    useMutation({
      mutationFn: async () => {
        const response = await refreshManagedThemeCatalog();
        themeCatalogSchema.parse(response);
        return response;
      },
      onSuccess: async (response) => {
        client.setQueryData(catalogKey, response);
        await client.invalidateQueries({ queryKey: managedThemesKey });
      },
    }),
  );
  const mutation = useStableMutation(
    useMutation({
      retry: false,
      onMutate: () => setNotice(null),
      mutationFn: executeThemeAction,
      onSuccess: async (_, action) => {
        setNotice(`${action.id}: ${action.kind} confirmed by Cadencr.`);
        await reconcileThemeAction(client, action);
      },
      onError: async (_, action) => {
        setNotice(
          `${action.id}: the change was not confirmed. Reloading affected state before retrying.`,
        );
        await reconcileThemeAction(client, action);
      },
    }),
  );
  const recovery = useStableMutation(
    useMutation({
      retry: false,
      mutationFn: async () => {
        if (mutation.variables) await reconcileThemeAction(client, mutation.variables);
        else await client.invalidateQueries({ queryKey: managedThemesKey });
      },
    }),
  );
  return useMemo(
    () => ({ inventory, catalog, refresh, mutation, recovery, notice }),
    [inventory, catalog, refresh, mutation, recovery, notice],
  );
}
// Observer result objects are fresh each render; expose only the state/actions
// consumers need so unrelated parent renders preserve the marketplace facade.
function useStableQuery<T>({
  data,
  error,
  isSuccess,
  isError,
  isLoading,
  isFetching,
}: UseQueryResult<T>) {
  return useMemo(
    () => ({ data, error, isSuccess, isError, isLoading, isFetching }),
    [data, error, isSuccess, isError, isLoading, isFetching],
  );
}
function useStableMutation<T, V>({
  error,
  isSuccess,
  isError,
  isPending,
  variables,
  mutate,
  mutateAsync,
}: UseMutationResult<T, Error, V>) {
  return useMemo(
    () => ({ error, isSuccess, isError, isPending, variables, mutate, mutateAsync }),
    [error, isSuccess, isError, isPending, variables, mutate, mutateAsync],
  );
}

async function executeThemeAction(action: ThemeAction): Promise<void> {
  switch (action.kind) {
    case "install":
    case "update": {
      const body = { theme_id: action.id, version: action.version, index: action.index };
      const response =
        action.kind === "install"
          ? await installManagedTheme(body)
          : await updateManagedTheme(action.id, body);
      managedThemeEntrySchema.parse(response);
      return;
    }
    case "apply":
      managedThemeEntrySchema.parse(await applyManagedTheme(action.id));
      return;
    case "remove":
      z.object({ success: z.literal(true), fallback: z.string().nullable().optional() }).parse(
        await removeManagedTheme(action.id, { confirm_builtin_fallback: action.confirmFallback }),
      );
      return;
    case "duplicate": {
      duplicateThemeResponseSchema.parse(
        await duplicateManagedTheme(action.id, { label: action.label }),
      );
      return;
    }
  }
}

async function reconcileThemeAction(
  client: ReturnType<typeof useQueryClient>,
  action: ThemeAction,
): Promise<void> {
  // A failed response can follow a committed write, so errors reconcile the same affected state.
  await Promise.all([
    client.invalidateQueries({ queryKey: managedThemesKey }),
    action.kind === "apply" || action.kind === "remove"
      ? client.invalidateQueries({ queryKey: getWorkspaceSettingsQueryKey() })
      : Promise.resolve(),
    action.kind === "duplicate"
      ? invalidateByUrlPrefix(client, ["/api/themes", "/api/projects", "/api/features"])
      : Promise.resolve(),
  ]);
}

import { useMemo, useState } from "react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  getManagedThemeCatalog,
  refreshManagedThemeCatalog,
  installManagedTheme,
  updateManagedTheme,
  applyManagedTheme,
  removeManagedTheme,
  duplicateManagedTheme,
} from "@/api/generated";
import { getWorkspaceSettingsQueryKey } from "@/api/settings";
import {
  managedThemeEntrySchema,
  duplicateThemeResponseSchema,
  themeCatalogSchema,
  managedThemesKey,
} from "@/lib/theme-marketplace";
import { useManagedThemes } from "./useManagedThemes";
import { useStableMutation, useStableQuery } from "./stable-query";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import type { MarketplaceNotice } from "@/lib/marketplace";

type ThemeAction =
  | { kind: "install" | "update"; id: string; version: string }
  | { kind: "apply"; id: string }
  | { kind: "remove"; id: string; confirmFallback: boolean }
  | { kind: "duplicate"; id: string; label: string };
const catalogKey = ["marketplace", "theme-catalog"];
export const themeCatalogQuery = queryOptions({
  queryKey: catalogKey,
  staleTime: 60_000,
  queryFn: async ({ signal }) => {
    const response = await getManagedThemeCatalog(signal);
    themeCatalogSchema.parse(response);
    return response;
  },
});
export function useThemeMarketplace() {
  const client = useQueryClient();
  const [notice, setNotice] = useState<MarketplaceNotice | null>(null);
  const inventory = useStableQuery(useManagedThemes());
  const catalog = useStableQuery(useQuery(themeCatalogQuery));
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
      onSuccess: async (warning, action) => {
        setNotice({
          tone: "done",
          text: `${action.id}: ${action.kind} confirmed by Cadencr.${warning ? ` Warning: ${warning}` : ""}`,
        });
        await reconcileThemeAction(client, action);
      },
      onError: async (_, action) => {
        setNotice({
          tone: "error",
          text: `${action.id}: the change was not confirmed. Reloading affected state before retrying.`,
        });
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
async function executeThemeAction(action: ThemeAction): Promise<string | null> {
  switch (action.kind) {
    case "install":
    case "update": {
      const body = { theme_id: action.id, version: action.version };
      const response =
        action.kind === "install"
          ? await installManagedTheme(body)
          : await updateManagedTheme(action.id, body);
      return managedThemeEntrySchema.parse(response).warning ?? null;
    }
    case "apply":
      return managedThemeEntrySchema.parse(await applyManagedTheme(action.id)).warning ?? null;
    case "remove":
      z.object({ success: z.literal(true), fallback: z.string().nullable().optional() }).parse(
        await removeManagedTheme(action.id, { confirm_builtin_fallback: action.confirmFallback }),
      );
      return null;
    case "duplicate": {
      return (
        duplicateThemeResponseSchema.parse(
          await duplicateManagedTheme(action.id, { label: action.label }),
        ).warning ?? null
      );
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

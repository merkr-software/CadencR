import { useMemo, useState } from "react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  getManagedTabCatalog,
  refreshManagedTabCatalog,
  getManagedTabs,
  installManagedTab,
  updateManagedTab,
  removeManagedTab,
  pluginTabList,
  type SignedMixedCatalog,
} from "@/api/generated";
import { themeCatalogSchema } from "@/lib/theme-marketplace";
import { apiErrorCode } from "@/lib/api-errors";
import { PLUGIN_TAB_ERROR } from "@/lib/plugin-tabs/error-codes";
import type { MarketplaceNotice } from "@/lib/marketplace";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { useStableMutation, useStableQuery } from "./stable-query";

const catalogKey = ["marketplace", "tab-catalog"];
const inventoryKey = ["/api/marketplace/tabs"];
const entry = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  error: z.string().nullable().optional(),
  pending_version: z.string().nullable().optional(),
});
type Action =
  | { kind: "install" | "update"; id: string; version: string; index: SignedMixedCatalog }
  | { kind: "remove"; id: string };

/** Shared with read-only consumers (the sidebar's update badge) so they hit one cache entry. */
export const tabCatalogQuery = queryOptions({
  queryKey: catalogKey,
  staleTime: 60_000,
  queryFn: async ({ signal }) => {
    const response = await getManagedTabCatalog(signal);
    themeCatalogSchema.parse(response);
    return response;
  },
});
export const tabInventoryQuery = queryOptions({
  queryKey: inventoryKey,
  queryFn: async ({ signal }) => {
    const response = await getManagedTabs(signal);
    z.array(entry).parse(response);
    return response;
  },
});

export function useTabMarketplace() {
  const client = useQueryClient();
  const [notice, setNotice] = useState<MarketplaceNotice | null>(null);
  const catalog = useStableQuery(useQuery(tabCatalogQuery));
  const inventory = useStableQuery(useQuery(tabInventoryQuery));
  const summaries = useStableQuery(
    useQuery({
      queryKey: ["/api/plugin-tabs"],
      queryFn: ({ signal }) => pluginTabList(undefined, signal),
    }),
  );
  const reconcile = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: inventoryKey }),
      invalidateByUrlPrefix(client, "/api/plugin-tabs"),
    ]);
  };
  const refresh = useStableMutation(
    useMutation({
      mutationFn: async () => {
        const response = await refreshManagedTabCatalog();
        themeCatalogSchema.parse(response);
        return response;
      },
      onSuccess: async (response) => {
        client.setQueryData(catalogKey, response);
        await reconcile();
      },
    }),
  );
  const mutation = useStableMutation(
    useMutation({
      retry: false,
      onMutate: () => setNotice(null),
      mutationFn: async (action: Action): Promise<string | null> => {
        if (action.kind === "remove") {
          z.literal(true).parse(await removeManagedTab(action.id));
          return null;
        }
        const body = { tab_id: action.id, version: action.version, index: action.index };
        const result = entry.parse(
          action.kind === "install"
            ? await installManagedTab(body)
            : await updateManagedTab(action.id, body),
        );
        return result.pending_version ?? null;
      },
      onSuccess: async (staged, action) => {
        setNotice({
          tone: "done",
          text: staged
            ? `${action.id}: update ${staged} downloaded and verified. Review its permissions to install it.`
            : `${action.id}: ${action.kind} confirmed by Cadencr.`,
        });
        await reconcile();
      },
      onError: async (error, action) => {
        // A coded refusal is a known outcome — nothing changed — and the
        // Activity already shows it (with its code) as the one error line.
        // Only an unknown outcome (transport failure, unreadable answer)
        // earns the "not confirmed" notice.
        const code = apiErrorCode(error);
        if (code === null)
          setNotice({
            tone: "error",
            text: `${action.id}: the change was not confirmed. Reloading tab state.`,
          });
        await reconcile();
        // Which versions install here comes with the catalog: reload it too.
        if (code === PLUGIN_TAB_ERROR.platformUnsupported)
          await client.invalidateQueries({ queryKey: catalogKey });
      },
    }),
  );
  const recovery = useStableMutation(useMutation({ mutationFn: reconcile }));
  return useMemo(
    () => ({ catalog, inventory, summaries, refresh, mutation, recovery, notice }),
    [catalog, inventory, summaries, refresh, mutation, recovery, notice],
  );
}

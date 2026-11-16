import { useMemo, useState } from "react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  catalog,
  inventory,
  refreshCatalog,
  install,
  update,
  enabled,
  remove,
} from "@/api/generated";
import {
  catalogSchema,
  entrySchema,
  inventorySchema,
  type MarketplaceNotice,
} from "@/lib/marketplace";
import { useStableMutation, useStableQuery } from "./stable-query";

type MarketplaceAction =
  | { kind: "install" | "update"; id: string; version: string }
  | { kind: "enabled"; id: string; enabled: boolean }
  | { kind: "remove"; id: string };
const catalogKey = ["marketplace", "catalog"];
const inventoryKey = ["marketplace", "inventory"];
/** Shared with read-only consumers (the sidebar's update badge) so they hit one cache entry. */
export const providerCatalogQuery = queryOptions({
  queryKey: catalogKey,
  queryFn: async ({ signal }) => {
    const result = await catalog(signal);
    catalogSchema.parse(result);
    return result;
  },
  staleTime: 60_000,
});
export const providerInventoryQuery = queryOptions({
  queryKey: inventoryKey,
  staleTime: 60_000,
  queryFn: async ({ signal }) => {
    const result = await inventory(signal);
    inventorySchema.parse(result);
    return result;
  },
});
export function useMarketplace() {
  const client = useQueryClient();
  const [notice, setNotice] = useState<MarketplaceNotice | null>(null);
  const catalogQuery = useStableQuery(useQuery(providerCatalogQuery));
  const inventoryQuery = useStableQuery(useQuery(providerInventoryQuery));
  const refresh = useStableMutation(
    useMutation({
      mutationFn: async () => {
        const result = await refreshCatalog();
        catalogSchema.parse(result);
        return result;
      },
      onSuccess: (result) => client.setQueryData(catalogKey, result),
    }),
  );
  const mutation = useStableMutation(
    useMutation({
      retry: false,
      onMutate: () => setNotice(null),
      mutationFn: async (action: MarketplaceAction) => {
        switch (action.kind) {
          case "install": {
            const result = await install({
              provider_id: action.id,
              version: action.version,
            });
            entrySchema.parse(result);
            return result;
          }
          case "update": {
            const result = await update(action.id, { version: action.version });
            entrySchema.parse(result);
            return result;
          }
          case "enabled": {
            const result = await enabled(action.id, { enabled: action.enabled });
            entrySchema.parse(result);
            return result;
          }
          case "remove": {
            const result = await remove(action.id);
            entrySchema.parse(result);
            return result;
          }
        }
      },
      onSuccess: async (entry) => {
        setNotice({
          tone: "done",
          text: `${entry.id}: changes saved.${entry.restart_required ? " Restart Cadencr to apply them." : ""}`,
        });
        await client.invalidateQueries({ queryKey: inventoryKey });
      },
      onError: async () => {
        await client.invalidateQueries({ queryKey: inventoryKey });
      },
    }),
  );
  return useMemo(
    () => ({ catalogQuery, inventoryQuery, refresh, mutation, notice }),
    [catalogQuery, inventoryQuery, refresh, mutation, notice],
  );
}

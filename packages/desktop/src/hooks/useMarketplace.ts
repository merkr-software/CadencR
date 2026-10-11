import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  catalog,
  inventory,
  refreshCatalog,
  install,
  update,
  enabled,
  remove,
  type SignedManagedProviderIndex,
} from "@/api/generated";
import { catalogSchema, entrySchema, inventorySchema } from "@/lib/marketplace";

type MarketplaceAction =
  | { kind: "install" | "update"; id: string; version: string; index: SignedManagedProviderIndex }
  | { kind: "enabled"; id: string; enabled: boolean }
  | { kind: "remove"; id: string };
const catalogKey = ["marketplace", "catalog"];
const inventoryKey = ["marketplace", "inventory"];
export function useMarketplace() {
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const catalogQuery = useQuery({
    queryKey: catalogKey,
    queryFn: async ({ signal }) => {
      const result = await catalog(signal);
      catalogSchema.parse(result);
      return result;
    },
    staleTime: 60_000,
  });
  const inventoryQuery = useQuery({
    queryKey: inventoryKey,
    queryFn: async ({ signal }) => {
      const result = await inventory(signal);
      inventorySchema.parse(result);
      return result;
    },
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const result = await refreshCatalog();
      catalogSchema.parse(result);
      return result;
    },
    onSuccess: (result) => client.setQueryData(catalogKey, result),
  });
  const mutation = useMutation({
    retry: false,
    onMutate: () => setNotice(null),
    mutationFn: async (action: MarketplaceAction) => {
      switch (action.kind) {
        case "install": {
          const result = await install({
            provider_id: action.id,
            version: action.version,
            index: action.index,
          });
          entrySchema.parse(result);
          return result;
        }
        case "update": {
          const result = await update(action.id, { version: action.version, index: action.index });
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
      setNotice(
        `${entry.id}: changes saved.${entry.restart_required ? " Restart Cadencr to apply them." : ""}`,
      );
      await client.invalidateQueries({ queryKey: inventoryKey });
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey: inventoryKey });
    },
  });
  return useMemo(
    () => ({ catalogQuery, inventoryQuery, refresh, mutation, notice }),
    [catalogQuery, inventoryQuery, refresh, mutation, notice],
  );
}

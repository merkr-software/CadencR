import { useMemo, useState } from "react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customInstance } from "@/api/client";
import { lspCatalogSchema, lspInventorySchema, type LspCatalog } from "@/lib/lsp/marketplace";
import type { MarketplaceNotice } from "@/lib/marketplace";
import { useStableMutation, useStableQuery } from "./stable-query";

const catalogKey = ["marketplace", "lsp-catalog"];
const inventoryKey = ["/api/lsp/servers"];
const catalogRequest = async (refresh = false, signal?: AbortSignal) =>
  lspCatalogSchema.parse(
    await customInstance<unknown>({
      url: "/api/lsp/catalog",
      method: "GET",
      params: { refresh },
      signal,
    }),
  );
function resolutionInputs(catalog: LspCatalog): string {
  return JSON.stringify({
    signature: catalog.index?.signature,
    verified: catalog.verified,
    host: catalog.host_platform,
    recommended: catalog.recommended_versions,
    blocked: catalog.blocked_versions,
    unavailable: catalog.unavailable_versions,
    error: catalog.error,
  });
}
export const lspCatalogQuery = queryOptions({
  queryKey: catalogKey,
  staleTime: 60_000,
  queryFn: async ({ signal, client }) => {
    const catalog = await catalogRequest(false, signal);
    // Editors resolve from disk without waiting on catalog network access. Once
    // this shared acquisition finishes, discover suggestions from the new cache.
    const previous = client.getQueryData<LspCatalog>(catalogKey);
    if (!previous || resolutionInputs(previous) !== resolutionInputs(catalog))
      void client.invalidateQueries({ queryKey: ["/api/lsp/resolve"] });
    return catalog;
  },
});
export const lspInventoryQuery = queryOptions({
  queryKey: inventoryKey,
  queryFn: async ({ signal }) =>
    lspInventorySchema.parse(
      await customInstance<unknown>({ url: "/api/lsp/servers", method: "GET", signal }),
    ),
});
type Action =
  | { kind: "install" | "update"; id: string; version: string }
  | { kind: "remove"; id: string };

/** Cache entries are shared by settings, editor suggestions and the marketplace. */
export function useLspMarketplace() {
  const client = useQueryClient();
  const [notice, setNotice] = useState<MarketplaceNotice | null>(null);
  const catalog = useStableQuery(useQuery(lspCatalogQuery));
  const inventory = useStableQuery(useQuery(lspInventoryQuery));
  const reconcile = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: inventoryKey }),
      client.invalidateQueries({ queryKey: ["/api/lsp/resolve"] }),
    ]);
  };
  const refresh = useStableMutation(
    useMutation({
      mutationFn: () => catalogRequest(true),
      onSuccess: async (response) => {
        client.setQueryData(catalogKey, response);
        await reconcile();
      },
    }),
  );
  const mutation = useStableMutation(
    useMutation({
      mutationKey: ["lsp-installation"],
      retry: false,
      onMutate: () => setNotice(null),
      mutationFn: async (action: Action) =>
        lspInventorySchema.parse(
          await customInstance<unknown>({
            url: `/api/lsp/${action.kind}`,
            method: "POST",
            data:
              action.kind === "remove"
                ? { lsp_id: action.id }
                : { lsp_id: action.id, version: action.version },
          }),
        ),
      onSuccess: async (_, action) => {
        setNotice({ tone: "done", text: `${action.id}: ${action.kind} confirmed by Cadencr.` });
        await reconcile();
      },
      onError: async () => {
        await reconcile();
      },
    }),
  );
  const recovery = useStableMutation(useMutation({ mutationFn: reconcile }));
  return useMemo(
    () => ({ catalog, inventory, refresh, mutation, recovery, notice }),
    [catalog, inventory, refresh, mutation, recovery, notice],
  );
}

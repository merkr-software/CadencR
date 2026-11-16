import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { getMarketplaceTrust, setAsideMarketplaceTrust } from "@/api/generated";
import { invalidateByUrlPrefix } from "@/lib/queryClient";

const trustKey = ["marketplace", "trust"];

const trustSchema = z.object({
  status: z.enum(["configured", "unconfigured", "invalid"]),
  error_code: z.string().nullish(),
  error: z.string().nullish(),
  recovery: z.enum(["reinstall", "update_app", "set_aside", "repair"]).nullish(),
  file: z.string().nullish(),
  kept_at: z.string().nullish(),
});
export type MarketplaceTrust = z.infer<typeof trustSchema>;

/**
 * The registry trust every marketplace kind verifies with. When it is
 * unusable, nothing in the marketplace verifies, so the page says why once.
 */
export function useMarketplaceTrust() {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: trustKey,
    queryFn: async ({ signal }) => trustSchema.parse(await getMarketplaceTrust(signal)),
  });
  const setAside = useMutation({
    retry: false,
    mutationFn: async () => trustSchema.parse(await setAsideMarketplaceTrust()),
    onSuccess: async (result) => {
      // The service answered with the trust it rebuilt; every catalog and
      // inventory verified under the old one is stale. Theme previews are
      // keyed by the catalog signature, so a new catalog refetches them.
      client.setQueryData(trustKey, result);
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["marketplace"],
          predicate: ({ queryKey }) => queryKey[1] !== "trust" && queryKey[1] !== "theme-preview",
        }),
        invalidateByUrlPrefix(client, ["/api/marketplace", "/api/lsp/servers"]),
      ]);
    },
  });
  return { status, setAside };
}

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { customInstance } from "@/api/client";
import { lspCatalogQuery } from "@/hooks/useLspMarketplace";
import { lspServerSchema } from "./marketplace";

const resolutionSchema = z.object({
  language_id: z.string(),
  servers: z.array(lspServerSchema),
  candidates: z.array(lspServerSchema),
  primary: z.string().nullable(),
  linters: z.array(z.string()),
  primary_disabled: z.boolean(),
  ignored: z.boolean(),
  suggestions: z.array(z.object({ lsp_id: z.string(), version: z.string(), reason: z.string() })),
  error: z.string().nullable(),
  catalog_warning: z.string().nullable().optional(),
});
export type LspResolution = z.infer<typeof resolutionSchema>;

/** The service owns language associations, inheritance, and legacy preferences. */
export function useLspResolution(
  params: { language_id?: string; file_path?: string; project_id?: number },
  enabled = true,
) {
  useQuery({ ...lspCatalogQuery, enabled });
  return useQuery({
    queryKey: ["/api/lsp/resolve", params],
    enabled,
    queryFn: async ({ signal }) =>
      resolutionSchema.parse(
        await customInstance<unknown>({
          url: "/api/lsp/resolve",
          method: "GET",
          params,
          signal,
        }),
      ),
  });
}

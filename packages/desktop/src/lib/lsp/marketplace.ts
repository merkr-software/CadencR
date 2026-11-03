import { z } from "zod";
import { lspLanguageSchema } from "../marketplace-lsp-package";
import { signedMixedCatalogSchema } from "../marketplace-catalog";

export const lspServerSchema = z.object({
  lsp_id: z.string(),
  name: z.string(),
  description: z.string(),
  language_ids: z.array(z.string()),
  languages: z.array(lspLanguageSchema),
  role: z.enum(["type_checker", "linter", "formatter", "general"]),
  status: z.enum(["managed", "on_path", "legacy", "invalid"]),
  version: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});
export const lspInventorySchema = z.object({ servers: z.array(lspServerSchema) });
export const lspCatalogSchema = z.object({
  index: signedMixedCatalogSchema.nullable(),
  verified: z.boolean(),
  error: z.string().nullable().optional(),
  host_platform: z.string().optional(),
  blocked_versions: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  unavailable_versions: z
    .record(
      z.string(),
      z.record(z.string(), z.enum(["platform", "protocol", "node", "policy", "compatibility"])),
    )
    .optional(),
  recommended_versions: z.record(z.string(), z.string()),
});
export type LspInventory = z.infer<typeof lspInventorySchema>;
export type LspCatalog = z.infer<typeof lspCatalogSchema>;

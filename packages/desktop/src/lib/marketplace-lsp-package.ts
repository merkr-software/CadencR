import { z } from "zod";
import { themeHostSchema } from "./marketplace-theme-package";

export const lspLanguageSchema = z
  .object({
    id: z.string(),
    extensions: z.array(z.string()),
    filenames: z.array(z.string()),
  })
  .strict();

const targetSchema = z
  .object({
    archive: z.string(),
    sha256: z.string(),
    size: z.number(),
    entry: z.string(),
    entry_sha256: z.string(),
    entry_size: z.number(),
    runtime: z.string().min(1),
  })
  .strict();

export const lspPackageSchema = z
  .object({
    lsp: z
      .object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        version: z.string(),
        repository: z.string(),
        license: z.string(),
        protocol_version: z.number().int().positive(),
        languages: z.array(lspLanguageSchema),
        root_markers: z.array(z.string()),
        role: z.enum(["type_checker", "linter", "formatter", "general"]),
        args: z.array(z.string()),
        initialization_options: z.record(z.string(), z.unknown()),
        distribution: z
          .object({ repository: z.string().optional(), binary: z.record(z.string(), targetSchema) })
          .strict(),
      })
      .strict(),
    host: themeHostSchema,
  })
  .strict();

export type LspMarketplacePackage = z.infer<typeof lspPackageSchema>;

import { z } from "zod";
import { themeHostSchema } from "./marketplace-theme-package";

export const lspLanguageSchema = z
  .object({
    id: z.string(),
    extensions: z.array(z.string()),
    filenames: z.array(z.string()),
  })
  .strict();

const minimumVersionSchema = z
  .string()
  .max(64)
  .regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?![\s\S])/);

const targetSchema = z
  .object({
    archive: z.string(),
    sha256: z.string(),
    size: z.number(),
    entry: z.string(),
    entry_sha256: z.string(),
    entry_size: z.number(),
    runtime: z.string().min(1),
    node_min_version: minimumVersionSchema.optional(),
    macos_min_version: minimumVersionSchema.optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.node_min_version !== undefined && target.runtime !== "node") {
      context.addIssue({
        code: "custom",
        path: ["node_min_version"],
        message: "A minimum Node.js version requires the Node runtime",
      });
    }
    if (target.macos_min_version !== undefined && target.runtime !== "native") {
      context.addIssue({
        code: "custom",
        path: ["macos_min_version"],
        message: "A minimum macOS version requires the native runtime",
      });
    }
  });

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
          .strict()
          .superRefine((distribution, context) => {
            for (const [platform, target] of Object.entries(distribution.binary)) {
              if (
                target.macos_min_version !== undefined &&
                platform !== "darwin-aarch64" &&
                platform !== "darwin-x86_64"
              ) {
                context.addIssue({
                  code: "custom",
                  path: ["binary", platform, "macos_min_version"],
                  message: "A minimum macOS version requires a Darwin target",
                });
              }
            }
          }),
      })
      .strict(),
    host: themeHostSchema,
  })
  .strict();

export type LspMarketplacePackage = z.infer<typeof lspPackageSchema>;

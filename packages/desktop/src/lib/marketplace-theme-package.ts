import { z } from "zod";

/**
 * A theme's `host`: who publishes it, which Cadencr it supports, and its
 * optional assets. A plugin's host is the same without assets.
 */
export const themeHostSchema = z
  .object({
    publisher: z.string(),
    compatibility: z
      .object({ min_app_version: z.string(), max_app_version: z.string().optional() })
      .strict(),
    assets: z
      .object({
        icon: z.string().optional(),
        readme: z.string().nullable().optional(),
        license: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Signed distribution metadata of a theme; the archive holds its declarative document. */
export const themePackageSchema = z
  .object({
    theme: z
      .object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        version: z.string(),
        repository: z.string(),
        license: z.string(),
        document_version: z.literal(1),
        distribution: z
          .object({
            repository: z.string().optional(),
            archive: z.string().url(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      })
      .strict(),
    host: themeHostSchema,
  })
  .strict();

export type ThemeMarketplacePackage = z.infer<typeof themePackageSchema>;

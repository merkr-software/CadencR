import { z } from "zod";
import { providerPackageSchema } from "./marketplace-provider-package";
import type { ManagedThemeCatalogResponse } from "@/api/generated";
import { THEME_TOKEN_KEYS, THEME_OPTIONAL_TOKEN_KEYS } from "./themes/tokens";
import { toThemeDefinition } from "./themes/user-theme";

export const managedThemesKey = ["marketplace", "managed-themes"] as const;

const color = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[;{}]|url\s*\(/i.test(value));
const blend = z.enum([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "luminosity",
]);
const image = z
  .object({
    asset: z.string().regex(/^[a-zA-Z0-9._-]+\.(?:png|jpe?g|webp)$/i),
    blend,
    fit: z.enum(["tile", "cover", "contain"]),
    opacity: z.number().min(0).max(1),
    scale: z.number().positive(),
  })
  .strict();
const chrome = z
  .object({
    chassis: z.enum(["flat", "rail"]).optional(),
    tabs: z.enum(["underline", "segmented"]).optional(),
    texture: z
      .object({
        base: color.nullable().optional(),
        halos: z
          .array(
            z
              .object({
                blur: z.number().nonnegative(),
                color,
                drift: z.number().nonnegative(),
                opacity: z.number().min(0).max(1),
                size: z.number().positive(),
                x: z.number(),
                y: z.number(),
              })
              .strict(),
          )
          .max(8)
          .optional(),
        image: image.nullable().optional(),
        grain: z
          .object({ blend, color, opacity: z.number().min(0).max(1), scale: z.number().positive() })
          .strict()
          .nullable()
          .optional(),
        veil: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const knownTokens = new Set<string>([...THEME_TOKEN_KEYS, ...THEME_OPTIONAL_TOKEN_KEYS]);
const documentSchema = z
  .object({
    $schema: z.string().nullable().optional(),
    label: z.string().min(1).max(64),
    appearance: z.enum(["dark", "light"]),
    cssVars: z.record(
      z.string().refine((key) => knownTokens.has(key)),
      color,
    ),
    xterm: z
      .object({
        background: color,
        foreground: color,
        cursor: color,
        cursorAccent: color,
        selectionBackground: color,
        selectionForeground: color,
        selectionInactiveBackground: color,
        black: color,
        red: color,
        green: color,
        yellow: color,
        blue: color,
        magenta: color,
        cyan: color,
        white: color,
        brightBlack: color,
        brightRed: color,
        brightGreen: color,
        brightYellow: color,
        brightBlue: color,
        brightMagenta: color,
        brightCyan: color,
        brightWhite: color,
      })
      .strict(),
    chrome: chrome.optional(),
  })
  .strict();
const authorThemeDataSchema = z.object({
  id: z.string().min(1),
  path: z.string(),
  content: z.string().max(256 * 1024),
  label: z.string().nullable().optional(),
  theme: documentSchema,
  issues: z.array(z.object({ token: z.string().nullable().optional(), message: z.string() })),
  assets: z.record(
    z.string(),
    z
      .string()
      .max(1024 * 1024)
      .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
  ),
});
export const managedThemeDataSchema = authorThemeDataSchema.extend({
  id: z.string().startsWith("managed:"),
});
export const duplicateThemeResponseSchema = z.object({
  theme: authorThemeDataSchema,
  workspace: z.object({
    project_id: z.number().int().positive(),
    feature_id: z.number().int().positive(),
    cwd: z.string().min(1),
    created: z.boolean(),
  }),
});
export const managedThemeEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    version: z.string(),
    sha256: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{64}$/)]),
    active: z.boolean(),
    theme: managedThemeDataSchema.nullable(),
    error: z.string().nullable().optional(),
    error_code: z.string().nullable().optional(),
  })
  .superRefine((entry, context) => {
    if (entry.theme && !entry.sha256)
      context.addIssue({
        code: "custom",
        path: ["sha256"],
        message: "Validated theme requires its revision digest",
      });
    if (!entry.theme && !entry.error)
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Unavailable theme requires a visible diagnostic",
      });
  });
const themePackageSchema = z
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
    host: z
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
      .strict(),
  })
  .strict();
const mixedEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("theme"), package: themePackageSchema }).strict(),
  z.object({ kind: z.literal("provider"), package: providerPackageSchema }).strict(),
]);
export const signedMixedCatalogSchema = z
  .object({
    signature: z
      .object({ algorithm: z.literal("ed25519"), key_id: z.string(), value: z.string() })
      .strict(),
    signed: z
      .object({
        schema_version: z.literal(2),
        generated_at: z.string(),
        expires_at: z.string(),
        packages: z.array(mixedEntrySchema),
      })
      .strict(),
  })
  .strict();
export const themeCatalogSchema = z
  .object({
    verified: z.boolean(),
    error: z.string().nullable().optional(),
    recommended_versions: z.record(z.string(), z.string()),
    index: signedMixedCatalogSchema.nullable().optional(),
  })
  .strict();
export type ThemeMarketplacePackage = z.infer<typeof themePackageSchema>;

export function groupThemePackages(
  catalog?: ManagedThemeCatalogResponse,
): ThemeMarketplacePackage[][] {
  const groups = new Map<string, ThemeMarketplacePackage[]>();
  for (const raw of catalog?.index?.signed.packages ?? []) {
    const entry = mixedEntrySchema.parse(raw);
    if (entry.kind !== "theme") continue;
    const versions = groups.get(entry.package.theme.id);
    if (versions) versions.push(entry.package);
    else groups.set(entry.package.theme.id, [entry.package]);
  }
  return [...groups.values()].sort((a, b) => a[0].theme.name.localeCompare(b[0].theme.name));
}
export function usableThemeCatalog(catalog?: ManagedThemeCatalogResponse): boolean {
  return (
    !!catalog?.verified &&
    !!catalog.index &&
    Date.parse(catalog.index.signed.expires_at) > Date.now()
  );
}
export function managedThemeDefinition(entry: z.infer<typeof managedThemeEntrySchema>) {
  if (!entry.theme?.theme) throw new Error("Managed theme document is missing");
  return {
    ...toThemeDefinition(entry.id, entry.theme.theme, entry.theme.assets),
    id: `managed:${entry.id}` as const,
  };
}

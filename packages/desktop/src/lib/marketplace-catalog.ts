import { z } from "zod";
import { lspPackageSchema } from "./marketplace-lsp-package";
import type { ManagedThemeCatalogResponse } from "@/api/generated";
import { providerPackageSchema } from "./marketplace-provider-package";
import { tabPackageSchema, type TabMarketplacePackage } from "./marketplace-tab-package";
import { isListingKind, isPluginKind } from "./marketplace-listing-base";
import { themeHostSchema, themePackageSchema } from "./marketplace-theme-package";

/**
 * The signed schema-2 catalog: `{kind, package}` entries. `theme`, `provider`
 * and `tab` are single kinds; `plugin` is one release contributing several of
 * them. A kind this build does not know (a newer registry may sign one) is
 * kept as `unknown` and skipped, never a reason to reject the whole catalog.
 */
const memberEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("theme"), package: themePackageSchema }).strict(),
  z.object({ kind: z.literal("provider"), package: providerPackageSchema }).strict(),
  z.object({ kind: z.literal("tab"), package: tabPackageSchema }).strict(),
  z.object({ kind: z.literal("lsp"), package: lspPackageSchema }).strict(),
]);

/** An entry of a kind this build does not know: only its declared kind is kept. */
const unknownEntrySchema = z
  .object({
    kind: z.string().refine((kind) => !isListingKind(kind), "known kind"),
    package: z.unknown(),
  })
  .transform((entry) => ({ kind: "unknown" as const, declared: entry.kind }));

const pluginPackageSchema = z
  .object({
    plugin: z
      .object({
        id: z.string().min(1),
        name: z.string(),
        description: z.string(),
        version: z.string(),
        repository: z.string(),
        license: z.string(),
      })
      .strict(),
    // Publisher and compatibility only: a plugin has no archive to hold assets.
    host: themeHostSchema.omit({ assets: true }).strict(),
    // A plugin never contributes a plugin: "plugin" is a known kind, so it
    // matches neither branch and the entry is rejected like the service does.
    contributes: z.array(z.union([memberEntrySchema, unknownEntrySchema])).min(1),
  })
  .strict();

const catalogEntrySchema = z.union([
  memberEntrySchema,
  z.object({ kind: z.literal("plugin"), package: pluginPackageSchema }).strict(),
  unknownEntrySchema,
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
        packages: z.array(catalogEntrySchema),
      })
      .strict(),
  })
  .strict();

/** One installable single-kind entry: a standalone package or a plugin member. */
export type CatalogMember = z.infer<typeof memberEntrySchema>;
export type PluginPackage = z.infer<typeof pluginPackageSchema>;
type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/**
 * Parsed entries per signed package list. Every kind's grouping and the plugin
 * listings read the same (immutable, query-cached) array on each build, so it
 * is parsed once per catalog response, not once per reader.
 */
const parsed = new WeakMap<readonly unknown[], CatalogEntry[]>();

function parseEntries(packages: readonly unknown[] | undefined): CatalogEntry[] {
  if (!packages) return [];
  const cached = parsed.get(packages);
  if (cached) return cached;
  const entries = packages.map((raw) => catalogEntrySchema.parse(raw));
  parsed.set(packages, entries);
  return entries;
}

function isMember(
  entry: CatalogEntry | PluginPackage["contributes"][number],
): entry is CatalogMember {
  return isPluginKind(entry.kind);
}

/**
 * Every installable single-kind entry, in catalog order: top-level themes,
 * providers and tabs plus each plugin's members — the same flattening the
 * service applies, so a member installs, updates and reports state by its own
 * id exactly like a standalone package. Unknown kinds are skipped.
 */
export function catalogMembers(packages: readonly unknown[] | undefined): CatalogMember[] {
  return parseEntries(packages).flatMap((entry) =>
    entry.kind === "plugin"
      ? entry.package.contributes.filter(isMember)
      : isMember(entry)
        ? [entry]
        : [],
  );
}

/** The plugin entries of a catalog (every version listed), in catalog order. */
export function catalogPlugins(packages: readonly unknown[] | undefined): PluginPackage[] {
  return parseEntries(packages).flatMap((entry) =>
    entry.kind === "plugin" ? [entry.package] : [],
  );
}

/** The catalog's custom tab packages by tab id, standalone and plugin members, every version. */
export function groupTabPackages(
  catalog?: ManagedThemeCatalogResponse,
): Map<string, TabMarketplacePackage[]> {
  const groups = new Map<string, TabMarketplacePackage[]>();
  for (const entry of catalogMembers(catalog?.index?.signed.packages)) {
    if (entry.kind !== "tab") continue;
    const versions = groups.get(entry.package.tab.id);
    if (versions) versions.push(entry.package);
    else groups.set(entry.package.tab.id, [entry.package]);
  }
  return groups;
}

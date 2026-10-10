import { z } from "zod";
import type {
  ManagedCatalogResponse,
  ManagedProviderInventoryEntry,
  ManagedProviderPackage,
} from "@/api/generated";

const nullableText = z.string().nullable().optional();
const binary = z
  .object({
    archive: z.string(),
    cmd: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    sha256: z.string().optional(),
  })
  .passthrough();
const packageDistribution = z
  .object({
    package: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
const agent = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    version: z.string().min(1),
    description: z.string(),
    authors: z.array(z.string()).optional(),
    license: z.string().optional(),
    repository: z.string().optional(),
    website: z.string().optional(),
    distribution: z
      .object({
        binary: z.record(z.string(), binary).optional(),
        npx: packageDistribution.optional(),
        uvx: packageDistribution.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const managedPackage = z
  .object({
    agent,
    host: z
      .object({
        publisher: z.string(),
        compatibility: z
          .object({ min_app_version: z.string(), max_app_version: nullableText })
          .passthrough(),
        assets: z
          .object({ readme: nullableText, license: nullableText, icon: z.string() })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
export const catalogSchema = z
  .object({
    source_configured: z.boolean(),
    cache_status: z.enum(["missing", "verified", "invalid", "expired"]),
    refreshed: z.boolean(),
    used_cached_verified_catalog: z.boolean(),
    signer_key_id: nullableText,
    generated_at: nullableText,
    expires_at: nullableText,
    error: nullableText,
    error_code: nullableText,
    index: z
      .object({
        signature: z
          .object({ algorithm: z.literal("ed25519"), key_id: z.string(), value: z.string() })
          .passthrough(),
        signed: z
          .object({
            schema_version: z.number(),
            generated_at: z.string(),
            expires_at: z.string(),
            packages: z.array(managedPackage),
          })
          .passthrough(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export const entrySchema = z.object({
  id: z.string(),
  version: nullableText,
  digest: nullableText,
  active_now: z.boolean(),
  active_after_restart: z.boolean(),
  enabled_after_restart: z.boolean(),
  restart_required: z.boolean(),
  error: nullableText,
  error_code: nullableText,
  history: z.array(
    z.object({
      action: z.enum(["installed", "updated", "rolled_back", "enabled", "disabled", "removed"]),
      sequence: z.number(),
      occurred_at: z.string(),
      version: nullableText,
      digest: nullableText,
      previous_version: nullableText,
      previous_digest: nullableText,
    }),
  ),
  quarantine: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      occurred_at: z.string(),
      stage: z.string(),
      version: z.string(),
      provider_id: z.string(),
      sequence: z.number(),
      digest: nullableText,
    }),
  ),
});
const processControlSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied") }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export const inventorySchema = z
  .object({
    providers: z.array(entrySchema),
    process_policy: z.object({
      memory_limit: processControlSchema,
      child_count_limit: processControlSchema,
      cpu_limit: processControlSchema,
      descendant_termination: processControlSchema,
      default_one_shot_timeout_seconds: z.number(),
    }),
    trust: z.object({
      status: z.enum(["configured", "unconfigured", "invalid"]),
      error: nullableText,
      error_code: nullableText,
      key_id: nullableText,
    }),
    blocklist: z.object({
      cache_status: z.enum(["missing", "verified", "invalid"]),
      error: nullableText,
      error_code: nullableText,
      source_configured: z.boolean(),
    }),
  })
  .passthrough();

export function usableCatalog(catalog?: ManagedCatalogResponse): boolean {
  return (
    catalog?.cache_status === "verified" &&
    !!catalog.index &&
    Date.parse(catalog.index.signed.expires_at) > Date.now()
  );
}
export function groupPackages(packages: ManagedProviderPackage[]): ManagedProviderPackage[][] {
  const groups = new Map<string, ManagedProviderPackage[]>();
  for (const entry of packages) {
    const group = groups.get(entry.agent.id);
    if (group) group.push(entry);
    else groups.set(entry.agent.id, [entry]);
  }
  return [...groups.values()].sort((a, b) => a[0].agent.name.localeCompare(b[0].agent.name));
}
export function installedRevision(entry?: ManagedProviderInventoryEntry): boolean {
  return !!entry?.version && !!entry.digest;
}

/** Display only the service's stable error shape; never arbitrary provider output. */
export function marketplaceError(error: unknown): string | null {
  if (!error) return null;
  const transport = z
    .object({ code: z.enum(["ECONNABORTED", "ETIMEDOUT", "ERR_NETWORK"]) })
    .safeParse(error);
  if (transport.success)
    return "Connection lost or timed out. The operation outcome is unknown; recheck Installed before retrying.";
  const response = z
    .object({ response: z.object({ data: z.object({ error: z.string(), code: z.string() }) }) })
    .safeParse(error);
  if (response.success)
    return `${response.data.response.data.code}: ${response.data.response.data.error}`;
  return error instanceof Error ? error.message : "Marketplace request failed.";
}

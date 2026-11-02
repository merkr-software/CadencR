import { z } from "zod";
import type { PluginTabSummary } from "@/api/generated";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const byteSize = z.number().int().positive();

/** One platform's native backend: its signed archive and the executable inside it. */
const backendBinarySchema = z
  .object({
    archive: z.string().url(),
    sha256,
    size: byteSize,
    cmd: z.string().min(1),
    executable_sha256: sha256,
    executable_size: byteSize,
  })
  .strict();

/**
 * Declared before download, so the install screen can say it runs native code.
 * Any protocol number parses: one this build does not speak only makes that
 * version uninstallable here (the catalog's `unavailable_versions`), never the
 * whole catalog unreadable.
 */
const backendSchema = z
  .object({ protocol: z.number().int().nonnegative(), reasoning: z.string().min(1) })
  .strict();

/** Signed distribution metadata; the archive contains the runtime's tab.json. */
export const tabPackageSchema = z
  .object({
    tab: z
      .object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        version: z.string(),
        repository: z.string(),
        license: z.string(),
        api_version: z.literal(1),
        backend: backendSchema.optional(),
        distribution: z
          .object({
            repository: z.string().optional(),
            archive: z.string().url(),
            sha256,
            // Keyed by platform; a key this build does not know is a platform it isn't on.
            binary: z
              .record(z.string().min(1), backendBinarySchema)
              .refine((targets) => Object.keys(targets).length > 0, "no backend platform")
              .optional(),
          })
          .strict(),
      })
      .strict()
      // A backend is declared and shipped together, or not at all.
      .refine((tab) => !tab.backend === !tab.distribution.binary, {
        message: "backend and distribution.binary must be listed together",
        path: ["backend"],
      }),
    host: z
      .object({
        publisher: z.string(),
        compatibility: z
          .object({ min_app_version: z.string(), max_app_version: z.string().optional() })
          .strict(),
        assets: z
          .object({
            icon: z.string(),
            readme: z.string().optional(),
            license: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export type TabMarketplacePackage = z.infer<typeof tabPackageSchema>;

/** What a tab version runs beyond its page, from the signed catalog entry. */
export interface TabNativeCode {
  reasoning: string;
  protocol: number;
  /** Platform keys (`darwin-aarch64`, …) it ships a binary for. */
  platforms: string[];
}

export function tabNativeCode(item: TabMarketplacePackage): TabNativeCode | null {
  const { backend, distribution } = item.tab;
  if (!backend) return null;
  return {
    reasoning: backend.reasoning,
    protocol: backend.protocol,
    platforms: Object.keys(distribution.binary ?? {}),
  };
}

/** The native backend of an installed revision, as Cadencr runs it. */
export function runtimeNativeCode(summary: PluginTabSummary): TabNativeCode | null {
  const backend = summary.backend;
  if (!backend) return null;
  return {
    reasoning: backend.reasoning ?? "",
    protocol: backend.protocol,
    platforms: Object.keys(backend.binary),
  };
}

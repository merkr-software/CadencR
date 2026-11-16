import { z } from "zod";
const nullableText = z.string().nullable().optional();
const binary = z
  .object({
    archive: z.string(),
    cmd: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    sha256: z.string().optional(),
  })
  .strict();
const packageDistribution = z
  .object({
    package: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const agent = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    version: z.string().min(1),
    description: z.string(),
    authors: z.array(z.string()).optional(),
    icon: z.string().optional(),
    license: z.string().optional(),
    repository: z.string().optional(),
    website: z.string().optional(),
    distribution: z
      .object({
        binary: z.record(z.string(), binary).optional(),
        npx: packageDistribution.optional(),
        uvx: packageDistribution.optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();
export const providerPackageSchema = z
  .object({
    agent,
    host: z
      .object({
        publisher: z.string(),
        compatibility: z
          .object({ min_app_version: z.string(), max_app_version: nullableText })
          .strict(),
        assets: z
          .object({ readme: nullableText, license: nullableText, icon: z.string() })
          .strict(),
      })
      .strict(),
  })
  .strict();

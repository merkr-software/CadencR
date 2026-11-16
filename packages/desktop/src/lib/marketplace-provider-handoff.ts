import { z } from "zod";

const owner = z.object({ publisher: z.string().min(1), repository: z.url() }).strict();

/** Authenticated by the service as part of the original signed payload. */
export const providerHandoffsSchema = z.array(
  z
    .object({
      provider_id: z.string().min(1),
      from: owner,
      to: owner,
      retired_versions: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
      authorization: z.url(),
      reason: z.string().min(1),
    })
    .strict(),
);

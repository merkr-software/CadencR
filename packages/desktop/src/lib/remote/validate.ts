/** Runtime guard for remote status consumed by the host store. */
import type { RemoteStatus } from "@/api/generated";
import { z } from "zod";

const remoteStatus: z.ZodType<RemoteStatus> = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535).nullish(),
  fingerprint: z.string().nullish(),
  tunnel_host: z.string().nullish(),
  lan_urls: z.array(z.string().url()),
  connected_devices: z.number().int().nonnegative(),
  pairing_state: z.enum(["none", "pending", "consumed", "expired"]),
  devices: z.array(
    z.object({
      id: z.number().int(),
      label: z.string().nullish(),
      created_at: z.string(),
      last_seen_at: z.string().nullish(),
    }),
  ),
  audit_tail: z.array(
    z.object({
      event: z.string(),
      device_id: z.number().int().nullish(),
      detail: z.string().nullish(),
      created_at: z.string(),
    }),
  ),
});

export function isRemoteStatus(value: unknown): value is RemoteStatus {
  return remoteStatus.safeParse(value).success;
}

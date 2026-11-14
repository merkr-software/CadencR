import { z } from "zod";

export const subscriptionPayload = z.object({ subscription_id: z.string() });
export const socketEventPayload = subscriptionPayload.extend({
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  envelope: z.object({
    domain: z.string(),
    action: z.string(),
    payload: z.unknown().optional(),
  }),
});
export const backendEventPayload = z.object({
  topic: z.string(),
  run_id: z.string().min(1),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  payload: z.json(),
});

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

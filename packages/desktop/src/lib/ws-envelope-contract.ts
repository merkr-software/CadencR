import { z } from "zod";
import type { WsEnvelope as GeneratedWsEnvelope, WsSessionCommand } from "@/api/generated";

/** Only the transport envelope is decoded here; provider payloads stay opaque. */
const envelopeSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  action: z.string().min(1),
  ref: z
    .string()
    .nullable()
    .transform((value) => value ?? undefined)
    .optional(),
  payload: z.unknown().refine((value): boolean => value !== undefined, "Missing envelope payload"),
}) satisfies z.ZodType<GeneratedWsEnvelope>;

export type WsEnvelope = z.infer<typeof envelopeSchema>;

export function decodeEnvelope(value: unknown): WsEnvelope {
  return envelopeSchema.parse(value);
}

// Distribute over the generated tagged union to preserve each action/payload
// pair, including when a caller passes a union instead of a literal action.
type CommandArguments<Command extends WsSessionCommand = WsSessionCommand> =
  Command extends WsSessionCommand
    ? [action: Command["action"], payload: Command["payload"]]
    : never;

export function createSessionEnvelope(...[action, payload]: CommandArguments): WsEnvelope {
  return { id: crypto.randomUUID(), domain: "session", action, payload };
}

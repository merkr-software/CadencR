import path from "node:path";
import { z } from "zod";

/** The one argument the `cadencr` CLI adds when it starts or reaches the app. */
export const CLI_REQUEST_FLAG = "--cadencr-request";

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), { message: "the path must be absolute" })
  .refine((value) => !value.includes("\0"), { message: "the path contains a NUL byte" });

const cliRequestSchema = z.discriminatedUnion("action", [
  z.object({ version: z.literal(1), action: z.literal("focus") }).strict(),
  z
    .object({
      version: z.literal(1),
      action: z.literal("open"),
      path: absolutePath,
      line: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ version: z.literal(1), action: z.literal("add"), path: absolutePath }).strict(),
  z.object({ version: z.literal(1), action: z.literal("update") }).strict(),
]);

export type CliRequest = z.infer<typeof cliRequestSchema>;

export type ParsedCliRequest = { ok: true; request: CliRequest } | { ok: false; message: string };

/**
 * Finds the CLI's request among the process arguments. Chromium may add its own
 * switches around it (in `second-instance` in particular), so the flag is looked
 * up anywhere rather than at a fixed position. `null`: the app was started
 * without one (a normal launch).
 */
export function parseCliRequestArgv(argv: readonly string[]): ParsedCliRequest | null {
  const prefix = `${CLI_REQUEST_FLAG}=`;
  const argument = argv.find((value) => value.startsWith(prefix));
  if (argument === undefined) return null;
  return parseCliRequest(argument.slice(prefix.length));
}

function parseCliRequest(raw: string): ParsedCliRequest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `The cadencr command sent an unreadable request: ${detail}` };
  }
  const parsed = cliRequestSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      message: `This version of Cadencr does not understand the cadencr command's request (${detail}). Update the command or the app so they match.`,
    };
  }
  return { ok: true, request: parsed.data };
}

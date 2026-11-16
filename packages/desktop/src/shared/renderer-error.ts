import { z } from "zod";
import type { rendererErrorSchema } from "./renderer-diagnostics";

export type RendererErrorReportPayload = z.input<typeof rendererErrorSchema>;

const errorFields = z.object({ message: z.string(), stack: z.string().nullish() });
// Recent V8 stores Error.stack behind a native accessor. Our realm's intrinsic
// reads the internal stack without invoking a getter supplied by the value.
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;

export function normalizeRendererError(value: unknown): { message: string; stack: string | null } {
  if (value instanceof Error) {
    return { message: value.message || String(value), stack: value.stack ?? null };
  }
  if (typeof value === "string") return { message: value, stack: null };
  try {
    // Errors from another realm fail instanceof. Preserve data properties or a
    // native stack, without copying arbitrary payload fields/accessors.
    if (typeof value === "object" && value !== null) {
      const stack =
        Object.getOwnPropertyDescriptor(value, "stack")?.value ?? nativeStackGetter?.call(value);
      const message = Object.getOwnPropertyDescriptor(value, "message")?.value;
      const parsed = errorFields.safeParse({
        // new Error() has a stack but no own message property.
        message: message === undefined && typeof stack === "string" ? "" : message,
        stack,
      });
      if (parsed.success) return { message: parsed.data.message, stack: parsed.data.stack ?? null };
    }
    return { message: JSON.stringify(value) ?? String(value), stack: null };
  } catch {
    return { message: String(value), stack: null };
  }
}

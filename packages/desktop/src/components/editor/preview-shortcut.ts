import { z } from "zod";

const closeShortcut = z
  .object({
    type: z.literal("cadencr-preview-shortcut"),
    shortcut: z.literal("editor-close"),
    key: z.string().refine((key) => key.toLowerCase() === "w"),
    // The physical key varies by layout; it never controls the forwarded event.
    code: z.string().max(32),
    metaKey: z.boolean(),
    ctrlKey: z.boolean(),
    shiftKey: z.literal(false),
    altKey: z.literal(false),
  })
  .strict()
  .refine((value) => value.metaKey !== value.ctrlKey);

/** A sandbox message can request only the existing Mod+W close chord. */
export function previewCloseKey(message: unknown): KeyboardEventInit | null {
  const result = closeShortcut.safeParse(message);
  if (!result.success) return null;
  return {
    key: "w",
    code: "KeyW",
    metaKey: result.data.metaKey,
    ctrlKey: result.data.ctrlKey,
    shiftKey: false,
    altKey: false,
  };
}

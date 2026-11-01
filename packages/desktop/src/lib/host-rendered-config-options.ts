import { z } from "zod";
import type { RuntimeSessionConfigOption, RuntimeSessionConfigSelectOption } from "@/api/generated";

/**
 * Session config options the host already renders as its own controls, per the
 * `_meta.cadencr` conventions in docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md: a mode
 * selector whose values map to host permission modes drives the mode chip, and
 * an option with `role: "access_mode"` drives the access chip. Showing them in
 * the generic config popover too would offer two controls for one setting.
 */
const cadencrMetaSchema = z.object({
  cadencr: z
    .object({
      role: z.string().optional(),
      permissionMode: z.string().optional(),
    })
    .passthrough(),
});

function cadencrMeta(meta: unknown) {
  const parsed = cadencrMetaSchema.safeParse(meta);
  return parsed.success ? parsed.data.cadencr : undefined;
}

/** A select option's values in display order, with their group name. */
export function flattenChoices(
  option: Extract<RuntimeSessionConfigOption, { type: "select" }>,
): Array<{ option: RuntimeSessionConfigSelectOption; group?: string }> {
  if (option.choices.layout === "ungrouped") {
    return option.choices.options.map((choice) => ({ option: choice }));
  }
  return option.choices.groups.flatMap((group) =>
    group.options.map((choice) => ({ option: choice, group: group.name })),
  );
}

export function isHostRenderedConfigOption(option: RuntimeSessionConfigOption): boolean {
  if (cadencrMeta(option._meta)?.role === "access_mode") return true;
  return (
    option.category === "mode" &&
    option.type === "select" &&
    flattenChoices(option).some(({ option: value }) => !!cadencrMeta(value._meta)?.permissionMode)
  );
}

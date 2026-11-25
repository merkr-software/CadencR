import { formatExactNumber } from "../../src/lib/format-number";
import { formattingLocale } from "../../src/lib/i18n/formatting-locale";
import { z } from "zod";
import { translateUi as t, uiI18n } from "../../src/shared/ui-i18n";

const bytes = z.number().int().nonnegative();
const frame = z.object({
  operation: z.union([
    z.object({ step: z.enum(["create_backup", "reclaim_space"]), bytes }),
    z.object({
      step: z.enum(["update_schema", "rebuild_search", "check_integrity", "verify_integrity"]),
    }),
  ]),
  elapsed: z.number().int().nonnegative().nullable(),
});

function byteCount(value: number): string {
  const gigabytes = value >= 1024 ** 3;
  return new Intl.NumberFormat(formattingLocale(uiI18n.language), {
    style: "unit",
    unit: gigabytes ? "gigabyte" : "megabyte",
    minimumFractionDigits: gigabytes ? 1 : 0,
    maximumFractionDigits: gigabytes ? 1 : 0,
  }).format(gigabytes ? value / 1024 ** 3 : Math.floor(value / 1024 ** 2));
}

function describeOperation(op: z.infer<typeof frame>["operation"]): string {
  switch (op.step) {
    case "create_backup":
      return t(
        "system.startup.operation.createBackup",
        "Creating a {{size}} safety copy before applying database updates.",
        { size: byteCount(op.bytes) },
      );
    case "reclaim_space":
      return t(
        "system.startup.operation.reclaimSpace",
        "Rewriting the database to reclaim {{size}} of unused space. Conversations are preserved.",
        { size: byteCount(op.bytes) },
      );
    case "update_schema":
      return t(
        "system.startup.operation.updateSchema",
        "Applying database schema updates. Your conversations are preserved.",
      );
    case "rebuild_search":
      return t(
        "system.startup.operation.rebuildSearch",
        "Rebuilding conversation search without bulky tool results. Conversation data is not being deleted.",
      );
    case "check_integrity":
      return t(
        "system.startup.operation.checkIntegrity",
        "Checking database integrity before reclaiming unused space.",
      );
    case "verify_integrity":
      return t(
        "system.startup.operation.verifyIntegrity",
        "Verifying database integrity after reclaiming space.",
      );
  }
}

/** Legacy phase details and service errors are free-form and retain their original content. */
export function splashProgressDetail(detail: string | undefined): string | undefined {
  const prefix = "@progress ";
  if (!detail?.startsWith(prefix)) return detail;
  let value: unknown;
  try {
    value = JSON.parse(detail.slice(prefix.length));
  } catch (error) {
    if (error instanceof SyntaxError) return detail;
    throw error;
  }
  const result = frame.safeParse(value);
  if (!result.success) return detail;
  const { operation, elapsed } = result.data;
  const description = describeOperation(operation);
  if (elapsed === null) return description;
  const locale = formattingLocale(uiI18n.language);
  const duration =
    elapsed < 60
      ? t("system.startup.elapsedSeconds", "{{seconds}}s", {
          seconds: formatExactNumber(elapsed, locale),
        })
      : t("system.startup.elapsedMinutes", "{{minutes}}m {{seconds}}s", {
          minutes: formatExactNumber(Math.floor(elapsed / 60), locale),
          seconds: formatExactNumber(elapsed % 60, locale, 2),
        });
  return t("system.startup.elapsed", "{{description}} Elapsed: {{duration}}.", {
    description,
    duration,
  });
}

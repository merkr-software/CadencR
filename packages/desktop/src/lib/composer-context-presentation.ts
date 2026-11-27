import type { UiTranslator } from "@/lib/i18n/ui";
import type { ComposerContextItem } from "@/stores/composer-context-store";

type ContextContent = Omit<ComposerContextItem, "id">;

export function contextItemLabel(t: UiTranslator, item: ContextContent): string {
  switch (item.kind) {
    case "pasted":
      return t("conversation.composer.contextTray.pastedText", "Pasted text");
    case "review":
      return t("conversation.composer.contextTray.reviewComments", "Review comments");
    case "terminal":
      return t("workspace.tools.terminal.selectionLabel", "Terminal output");
    default:
      return item.label;
  }
}

export function contextItemDetail(t: UiTranslator, item: ContextContent): string | undefined {
  if (item.kind === "pasted" || item.kind === "terminal") {
    // Older drafts have the full content but no saved line count.
    return t("conversation.composer.contextTray.lineCount", {
      count: item.lineCount ?? item.content.split("\n").length,
      defaultValue_one: "{{count}} line",
      defaultValue_other: "{{count}} lines",
    });
  }
  if (item.kind !== "selection") return item.detail;

  const range = item.lineRange ?? legacyLineRange(item.detail);
  if (!range) return item.detail;
  const { start, end } = range;
  return start === end
    ? t("conversation.composer.contextTray.selectedLine", "line {{start, number}}", { start })
    : t(
        "conversation.composer.contextTray.selectedLines",
        "lines {{start, number}}–{{end, number}}",
        {
          start,
          end,
        },
      );
}

function legacyLineRange(detail: string | undefined): ContextContent["lineRange"] {
  const match = detail?.match(/^(?:line (\d+)|lines (\d+)–(\d+))$/);
  if (!match) return undefined;
  return { start: Number(match[1] ?? match[2]), end: Number(match[1] ?? match[3]) };
}

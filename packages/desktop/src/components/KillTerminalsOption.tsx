import type { ReactElement } from "react";
import { SquareTerminalIcon } from "lucide-react";
import { CleanupOption } from "@/components/CleanupOption";
import { useUiTranslation } from "@/lib/i18n/ui";

interface KillTerminalsOptionProps {
  count: number;
  /** Browser tabs closed along with the shells (the archive dialog's). */
  browserCount?: number;
  checked: boolean;
  onToggle: () => void;
}

function activityDescription(
  t: ReturnType<typeof useUiTranslation>["t"],
  shellCount: number,
  browserCount: number,
): string {
  if (shellCount <= 0) {
    return t(
      "sidebar.cleanup.closeBrowserTabsDescription",
      "Close the {{count}} browser tabs in this session.",
      {
        count: browserCount,
        defaultValue_one: "Close the {{count}} browser tab in this session.",
        defaultValue_other: "Close the {{count}} browser tabs in this session.",
      },
    );
  }
  if (browserCount <= 0) {
    return t(
      "sidebar.cleanup.stopShellsDescription",
      "Stop the {{count}} running shells in this session.",
      {
        count: shellCount,
        defaultValue_one: "Stop the {{count}} running shell in this session.",
        defaultValue_other: "Stop the {{count}} running shells in this session.",
      },
    );
  }
  if (browserCount === 1) {
    return t(
      "sidebar.cleanup.stopShellsAndCloseTabDescription",
      "Stop the {{count}} running shells and close the {{browserCount}} browser tab in this session.",
      {
        count: shellCount,
        browserCount,
        defaultValue_one:
          "Stop the {{count}} running shell and close the {{browserCount}} browser tab in this session.",
        defaultValue_other:
          "Stop the {{count}} running shells and close the {{browserCount}} browser tab in this session.",
      },
    );
  }
  return t(
    "sidebar.cleanup.stopShellsAndCloseTabsDescription",
    "Stop the {{count}} running shells and close the {{browserCount}} browser tabs in this session.",
    {
      count: shellCount,
      browserCount,
      defaultValue_one:
        "Stop the {{count}} running shell and close the {{browserCount}} browser tabs in this session.",
      defaultValue_other:
        "Stop the {{count}} running shells and close the {{browserCount}} browser tabs in this session.",
    },
  );
}

/** Cleanup-dialog option to kill the feature's running shells (shortcut `T`). */
export function KillTerminalsOption(props: KillTerminalsOptionProps): ReactElement {
  const { t } = useUiTranslation();
  const browserCount = props.browserCount ?? 0;
  const description = activityDescription(t, props.count, browserCount);
  const label =
    browserCount <= 0
      ? t("sidebar.cleanup.killTerminals", "Kill terminals")
      : props.count > 0
        ? t("sidebar.cleanup.closeTerminalsAndBrowsers", "Close terminals & browsers")
        : t("sidebar.cleanup.closeBrowserTabs", "Close browser tabs", {
            count: browserCount,
            defaultValue_one: "Close browser tab",
            defaultValue_other: "Close browser tabs",
          });
  return (
    <CleanupOption
      checked={props.checked}
      icon={<SquareTerminalIcon className="size-4" />}
      label={label}
      shortcut="T"
      description={description}
      onCheckedChange={props.onToggle}
    />
  );
}

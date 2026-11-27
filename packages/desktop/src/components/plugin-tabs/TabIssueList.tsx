import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import type { ReactNode } from "react";

import type { TabIssue } from "@/api/generated";
import { cn } from "@/lib/utils";

/** Code and field identify these messages without parsing service diagnostics. */
function issueMessage(issue: TabIssue, t: UiTranslator): string {
  switch (issue.code) {
    case "KIND_INVALID":
      return t("customTabs.issues.invalidKind", 'must be "tab"');
    case "ID_INVALID":
      return t(
        "customTabs.issues.invalidId",
        "must be 1–64 lowercase letters, digits or inner hyphens",
      );
    case "ID_RESERVED":
      return t("customTabs.issues.reservedId", "is reserved by Cadencr");
    case "VERSION_INVALID":
      return t("customTabs.issues.invalidVersion", "must be a semantic version such as 0.1.0");
    case "PATH_INVALID":
      return issue.field?.startsWith("backend.binary.")
        ? t(
            "customTabs.issues.invalidBinaryPath",
            "must be a normalized relative path inside the tab folder, without `..`, `.`, backslashes or a leading `/`",
          )
        : t(
            "customTabs.issues.invalidPath",
            "must be a normalized relative path without `..`, `.`, backslashes or a leading `/`",
          );
    case "ORIGIN_DUPLICATE":
      return t("customTabs.issues.duplicateOrigin", "listed twice");
    case "ORIGIN_INSECURE_LOCALHOST":
      return t(
        "customTabs.issues.insecureLocalhost",
        "plain http is only for local development; publishable tabs use https",
      );
    case "NETWORK_REASONING_REQUIRED":
      return t(
        "customTabs.issues.networkReasoning",
        "explain why the tab needs network access; it is shown at consent time",
      );
    case "CONFIG_KEY_INVALID":
      return t("customTabs.issues.invalidConfigKey", "must match ^[a-z][a-z0-9_]{0,47}$");
    case "CONFIG_OPTIONS_REQUIRED":
      return t("customTabs.issues.requiredOptions", "a select needs at least one option");
    case "CONFIG_OPTIONS_UNEXPECTED":
      return t("customTabs.issues.unexpectedOptions", "only select fields take options");
    case "CONFIG_SECRET_DEFAULT":
      return t("customTabs.issues.secretDefault", "a secret cannot have a default");
    case "CONFIG_DEFAULT_INVALID":
      return t("customTabs.issues.invalidDefault", "does not match the field's type or options");
    case "COMMAND_INVALID":
      return t(
        "customTabs.issues.invalidCommand",
        "must be a bare program name such as `git`, without a path or arguments",
      );
    case "SHORTCUT_KEYS_DUPLICATE":
      return t(
        "customTabs.issues.duplicateShortcutKeys",
        "another shortcut already uses these keys",
      );
    default:
      return issue.message;
  }
}

/**
 * Manifest validation findings, each with its stable code (so it can be
 * looked up or grepped) and the field it concerns. Shared by the tab's own
 * overlay and its Settings card so the two never drift apart.
 */
export function TabIssueList({
  issues,
  className,
}: {
  issues: readonly TabIssue[];
  className?: string;
}): ReactNode {
  const { t } = useUiTranslation();
  if (issues.length === 0) return null;
  return (
    <ul className={cn("space-y-1.5 text-left", className)}>
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className="text-[11.5px] leading-snug">
          <span className="font-mono text-[10.5px] text-foreground/80">{issue.code}</span>
          {issue.field ? (
            <span className="font-mono text-[10.5px] text-muted-foreground"> · {issue.field}</span>
          ) : null}
          <span className="block text-muted-foreground">{issueMessage(issue, t)}</span>
        </li>
      ))}
    </ul>
  );
}

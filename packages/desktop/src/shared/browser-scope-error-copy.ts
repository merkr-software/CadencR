import type { translateUi } from "./ui-i18n";

type Translator = typeof translateUi;

export interface BrowserTabSessionIssue {
  kind: "tabSession";
  reason: "corrupt" | "invalid" | "storageLimit" | "scopeLimit" | "cleanupFailed";
  diagnostics?: readonly string[];
}

export type BrowserResponsiveRecovery =
  | "appearanceReset"
  | "overridesReset"
  | "viewportSize"
  | "pageZoom"
  | "touchInterrupted"
  | "restoreSettling";

export type BrowserScopeIssue =
  | BrowserTabSessionIssue
  | { kind: "restoreTabs"; detail: string }
  | { kind: "saveTabs"; detail: string | BrowserTabSessionIssue }
  | {
      kind: "responsiveRecovery";
      context: BrowserResponsiveRecovery;
      detail: string;
      cleanupDetail?: string;
    }
  | { kind: "responsiveRollback"; diagnostics: readonly string[] };

export function browserScopeErrorText(issue: BrowserScopeIssue, t: Translator): string {
  switch (issue.kind) {
    case "tabSession":
      return withDiagnostics(tabSessionErrorText(issue.reason, t), issue.diagnostics, t);
    case "restoreTabs":
      return t(
        "workspace.browser.tab.restoreFailed",
        "Could not restore Browser tabs: {{detail}}",
        {
          detail: issue.detail,
        },
      );
    case "saveTabs":
      return t("workspace.browser.tab.saveFailed", "Could not save Browser tabs: {{detail}}", {
        detail:
          typeof issue.detail === "string" ? issue.detail : browserScopeErrorText(issue.detail, t),
      });
    case "responsiveRecovery": {
      const context = responsiveContextText(issue.context, t);
      const label =
        issue.cleanupDetail === undefined
          ? context
          : t("workspace.browser.responsive.cleanupFailed", "{{context}}; cleanup also failed.", {
              context,
            });
      const diagnostics =
        issue.cleanupDetail === undefined ? [issue.detail] : [issue.detail, issue.cleanupDetail];
      return withDiagnostics(label, diagnostics, t);
    }
    case "responsiveRollback":
      return withDiagnostics(
        t(
          "workspace.browser.responsive.updateAndRollbackFailed",
          "Responsive update and rollback failed.",
        ),
        issue.diagnostics,
        t,
      );
  }
}

function withDiagnostics(
  label: string,
  diagnostics: readonly string[] | undefined,
  t: Translator,
): string {
  return diagnostics?.length
    ? t("common.labelWithDetail", "{{label}}: {{detail}}", {
        label,
        detail: diagnostics.join("\n"),
      })
    : label;
}

function tabSessionErrorText(reason: BrowserTabSessionIssue["reason"], t: Translator): string {
  switch (reason) {
    case "corrupt":
      return t(
        "workspace.browser.tab.sessionCorrupt",
        "Saved Browser tabs could not be read because the data is corrupt.",
      );
    case "invalid":
      return t(
        "workspace.browser.tab.sessionInvalid",
        "Saved Browser tabs could not be read because the data is invalid.",
      );
    case "storageLimit":
      return t(
        "workspace.browser.tab.sessionStorageLimit",
        "Saved Browser tabs exceed their storage limit.",
      );
    case "scopeLimit":
      return t(
        "workspace.browser.tab.sessionScopeLimit",
        "Saved Browser tabs contain too many scopes.",
      );
    case "cleanupFailed":
      return t(
        "workspace.browser.tab.sessionCleanupFailed",
        "Saved Browser tabs write and cleanup failed.",
      );
  }
}

function responsiveContextText(context: BrowserResponsiveRecovery, t: Translator): string {
  switch (context) {
    case "appearanceReset":
      return t(
        "workspace.browser.responsive.appearanceReset",
        "DevTools reset responsive appearance",
      );
    case "overridesReset":
      return t(
        "workspace.browser.responsive.overridesReset",
        "DevTools reset responsive overrides",
      );
    case "viewportSize":
      return t(
        "workspace.browser.responsive.viewportSize",
        "Responsive viewport could not follow the Browser size",
      );
    case "pageZoom":
      return t(
        "workspace.browser.responsive.pageZoom",
        "Responsive viewport could not preserve page zoom",
      );
    case "touchInterrupted":
      return t(
        "workspace.browser.responsive.touchInterrupted",
        "Responsive touch and appearance were interrupted",
      );
    case "restoreSettling":
      return t(
        "workspace.browser.responsive.restoreSettling",
        "The restored responsive viewport is still settling",
      );
  }
}

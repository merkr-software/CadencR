import {
  browserScopeErrorText,
  type BrowserScopeIssue,
} from "../../src/shared/browser-scope-error-copy";
import { translateUi } from "../../src/shared/ui-i18n";

export class BrowserScopeFailure extends Error {
  constructor(
    readonly issue: BrowserScopeIssue,
    options?: ErrorOptions,
  ) {
    super(browserScopeErrorText(issue, translateUi), options);
  }
}

export class BrowserScopeAggregateFailure extends AggregateError {
  constructor(
    readonly issue: BrowserScopeIssue,
    errors: readonly unknown[],
  ) {
    super(errors, browserScopeErrorText(issue, translateUi));
  }
}

export function browserScopeIssue(error: unknown): BrowserScopeIssue | undefined {
  if (error instanceof BrowserScopeFailure || error instanceof BrowserScopeAggregateFailure) {
    return error.issue;
  }
  return undefined;
}

export function browserErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function browserTabSaveFailure(error: unknown): BrowserScopeFailure {
  const issue = browserScopeIssue(error);
  return new BrowserScopeFailure(
    { kind: "saveTabs", detail: issue?.kind === "tabSession" ? issue : browserErrorMessage(error) },
    { cause: error },
  );
}

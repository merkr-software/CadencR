import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, type ChangeEvent, type KeyboardEvent, type ReactElement } from "react";
import { ChevronDownIcon, ChevronUpIcon, Loader2Icon, SearchIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_BROWSER_FIND_QUERY_LENGTH } from "@/shared/browser-types";

import type { BrowserFindModel } from "./useBrowserFind";

export const BrowserFindToolbar = memo(function BrowserFindToolbar({
  find,
}: {
  find: BrowserFindModel;
}): ReactElement {
  const { t } = useUiTranslation();
  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    find.setQuery(event.target.value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      find.closeFind();
      return;
    }
    if (event.key !== "Enter" || find.query.length === 0) return;
    event.preventDefault();
    if (event.shiftKey) find.previous();
    else find.next();
  }

  const resultLabel = find.pending
    ? "Searching"
    : find.query.length === 0
      ? t("workspace.tools.browserFindToolbar.typeToSearch", "Type to search")
      : t("workspace.tools.browserFindToolbar.matchCount", "{{match}} of {{total}}", {
          match: find.activeMatchOrdinal,
          total: find.matches,
        });

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 border-b bg-card px-2 py-1.5">
      <div className="flex min-w-0 basis-48 flex-1 items-center gap-1.5 rounded-md border bg-background px-2">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          ref={find.inputRef}
          value={find.query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          aria-label={t("workspace.tools.browserFindToolbar.findInPage", "Find in page")}
          maxLength={MAX_BROWSER_FIND_QUERY_LENGTH}
          variant="ghost"
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <span
          className="min-w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground"
          role="status"
          aria-label={t("workspace.tools.browserFindToolbar.findResults", "Find results")}
          aria-live="polite"
        >
          {find.pending ? (
            <>
              <Loader2Icon aria-hidden="true" className="ml-auto size-3 animate-spin" />
              <span className="sr-only">
                {t("workspace.tools.browserFindToolbar.searching", "Searching")}
              </span>
            </>
          ) : (
            resultLabel
          )}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={find.query.length === 0 || find.pending}
        onClick={find.previous}
        aria-label={t("workspace.tools.browserFindToolbar.previousMatch", "Previous match")}
      >
        <ChevronUpIcon className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={find.query.length === 0 || find.pending}
        onClick={find.next}
        aria-label={t("workspace.tools.browserFindToolbar.nextMatch", "Next match")}
      >
        <ChevronDownIcon className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={find.closeFind}
        aria-label={t("workspace.tools.browserFindToolbar.closeFindInPage", "Close find in page")}
      >
        <XIcon className="size-4" />
      </Button>
      {find.error ? (
        <span className="basis-full truncate text-right text-xs text-destructive" role="alert">
          {find.error}
        </span>
      ) : null}
    </div>
  );
});

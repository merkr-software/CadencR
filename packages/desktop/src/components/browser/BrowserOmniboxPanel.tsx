import { type UiTranslator, useUiTranslation } from "@/lib/i18n/ui";
import { type PointerEvent, type ReactElement } from "react";
import {
  BookOpenIcon,
  HistoryIcon,
  Loader2Icon,
  SearchIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BrowserOmniboxSuggestion } from "@/lib/browser-omnibox";
import { cn } from "@/lib/utils";
import type { BrowserUrlFieldProps } from "./BrowserAddressBarParts";

type BrowserSuggestionPanelProps = Pick<
  BrowserUrlFieldProps,
  | "bookmarkPending"
  | "error"
  | "highlighted"
  | "historyCount"
  | "isQuerying"
  | "listboxId"
  | "onClearHistory"
  | "onHighlightSuggestion"
  | "onRemoveHistory"
  | "onSelectSuggestion"
  | "suggestions"
>;

export function BrowserOmniboxPanel(props: BrowserSuggestionPanelProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
      <ul
        id={props.listboxId}
        role="listbox"
        aria-label={t(
          "workspace.tools.browserOmniboxPanel.browserSuggestions",
          "Browser suggestions",
        )}
        className="max-h-64 overflow-y-auto p-1"
      >
        {props.suggestions.map((suggestion, index) => (
          <BrowserSuggestionOption
            key={suggestion.id}
            id={`${props.listboxId}-option-${index}`}
            suggestion={suggestion}
            index={index}
            highlighted={index === props.highlighted}
            mutationPending={props.bookmarkPending}
            onSelect={props.onSelectSuggestion}
            onHighlight={props.onHighlightSuggestion}
            onRemoveHistory={props.onRemoveHistory}
          />
        ))}
        {props.isQuerying ? (
          <li
            role="presentation"
            className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground"
          >
            <Loader2Icon className="size-3.5 animate-spin" />{" "}
            {t(
              "workspace.tools.browserOmniboxPanel.loadingLocalSuggestions",
              "Loading local suggestions…",
            )}
          </li>
        ) : null}
        {!props.isQuerying && props.suggestions.length === 0 && !props.error ? (
          <li role="presentation" className="px-2 py-2 text-xs text-muted-foreground">
            {t("workspace.tools.browserOmniboxPanel.noLocalSuggestions", "No local suggestions")}
          </li>
        ) : null}
      </ul>
      {props.error ? (
        <div role="alert" className="border-t border-border/60 px-3 py-2 text-xs text-destructive">
          {props.error}
        </div>
      ) : null}
      <HistoryFooter {...props} />
    </div>
  );
}

function HistoryFooter(props: BrowserSuggestionPanelProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground">
      <span>
        {props.historyCount > 0
          ? t("workspace.tools.browserOmniboxPanel.historyCount", {
              count: props.historyCount,
              defaultValue_one: "{{count}} recent history entry",
              defaultValue_other: "{{count}} recent history entries",
            })
          : t(
              "workspace.tools.browserOmniboxPanel.recentHistoryAndLegacySuggestions",
              "Recent history and legacy suggestions",
            )}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={props.bookmarkPending}
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onClearHistory}
      >
        <Trash2Icon className="size-3" />{" "}
        {t("workspace.tools.browserOmniboxPanel.clearHistory", "Clear history")}
      </Button>
    </div>
  );
}

interface SuggestionOptionProps {
  id: string;
  suggestion: BrowserOmniboxSuggestion;
  index: number;
  highlighted: boolean;
  mutationPending: boolean;
  onSelect: (suggestion: BrowserOmniboxSuggestion) => void;
  onHighlight: (index: number) => void;
  onRemoveHistory: (id: string) => void;
}

function BrowserSuggestionOption(props: SuggestionOptionProps): ReactElement {
  const { t } = useUiTranslation();
  const { suggestion } = props;
  function handlePointerDown(event: PointerEvent<HTMLLIElement>): void {
    event.preventDefault();
    props.onSelect(suggestion);
  }
  function handleDeletePointerDown(event: PointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
  }
  return (
    <li
      id={props.id}
      role="option"
      aria-selected={props.highlighted}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs",
        props.highlighted
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent hover:text-accent-foreground",
      )}
      onPointerDown={handlePointerDown}
      onMouseEnter={() => props.onHighlight(props.index)}
    >
      <SuggestionIcon source={suggestion.source} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">
          {suggestion.source === "search"
            ? t("workspace.tools.browserOmniboxPanel.searchFor", "Search for “{{query}}”", {
                query: suggestion.title,
              })
            : suggestion.title}
        </span>
        <span className="block truncate font-mono text-[10px] text-muted-foreground">
          {suggestionSourceLabel(t, suggestion.source)} · {suggestion.url}
        </span>
      </span>
      {suggestion.historyId ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={props.mutationPending}
          aria-label={t(
            "workspace.tools.browserOmniboxPanel.deleteHistoryEntry",
            "Delete {{title}} from history",
            { title: suggestion.title },
          )}
          onPointerDown={handleDeletePointerDown}
          onClick={() => suggestion.historyId && props.onRemoveHistory(suggestion.historyId)}
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <Trash2Icon className="size-3" />
        </Button>
      ) : null}
    </li>
  );
}

function SuggestionIcon({ source }: { source: BrowserOmniboxSuggestion["source"] }): ReactElement {
  if (source === "tab")
    return <BookOpenIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />;
  if (source === "history")
    return <HistoryIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />;
  if (source === "search")
    return <SearchIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />;
  return <StarIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />;
}

function suggestionSourceLabel(
  t: UiTranslator,
  source: BrowserOmniboxSuggestion["source"],
): string {
  if (source === "tab") return t("workspace.tools.browserOmniboxPanel.openTab", "Open tab");
  if (source === "bookmark") return t("workspace.tools.browserOmniboxPanel.bookmark", "Bookmark");
  if (source === "history") return t("workspace.tools.browserOmniboxPanel.history", "History");
  return t("workspace.tools.browserOmniboxPanel.search", "Search");
}

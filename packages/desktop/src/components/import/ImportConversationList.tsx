import { type UiTranslator, useUiTranslation } from "@/lib/i18n/ui";
import { memo } from "react";
import { Search } from "lucide-react";
import type { ImportConversationSummary } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";

export interface ImportConversationSelection {
  filtered: ImportConversationSummary[];
  visibleSelectableIds: string[];
  selectedCount: number;
  selectAllState: boolean | "indeterminate";
}

export interface ImportConversationListProps {
  conversations: ImportConversationSummary[];
  error: unknown;
  isError: boolean;
  isImporting: boolean;
  isLoading: boolean;
  onBack: () => void;
  onImport: () => void;
  onQueryChange: (value: string) => void;
  onRefetch: () => Promise<unknown>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  providerLabel: string;
  query: string;
  selectedIds: ReadonlySet<string>;
  selection: ImportConversationSelection;
}

function ImportConversationListInner({
  conversations,
  error,
  isError,
  isImporting,
  isLoading,
  onBack,
  onImport,
  onQueryChange,
  onRefetch,
  onToggle,
  onToggleAll,
  providerLabel,
  query,
  selectedIds,
  selection,
}: ImportConversationListProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <SearchBox query={query} onQueryChange={onQueryChange} />
      <SelectAllRow
        query={query}
        selectAllState={selection.selectAllState}
        visibleSelectableIds={selection.visibleSelectableIds}
        onToggleAll={onToggleAll}
      />
      <ConversationListPanel
        conversations={conversations}
        error={error}
        filtered={selection.filtered}
        isError={isError}
        isLoading={isLoading}
        onRefetch={onRefetch}
        onToggle={onToggle}
        providerLabel={providerLabel}
        selectedIds={selectedIds}
      />
      <ImportFooter
        isImporting={isImporting}
        onBack={onBack}
        onImport={onImport}
        selectedCount={selection.selectedCount}
      />
    </div>
  );
}

interface SearchBoxProps {
  query: string;
  onQueryChange: (value: string) => void;
}

function SearchBox({ query, onQueryChange }: SearchBoxProps) {
  const { t } = useUiTranslation();
  return (
    <div className="relative shrink-0">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={t(
          "conversation.importConversationList.searchConversationsByTitle",
          "Search conversations by title…",
        )}
        className="h-8 pl-8 text-sm"
      />
    </div>
  );
}

interface SelectAllRowProps {
  query: string;
  selectAllState: boolean | "indeterminate";
  visibleSelectableIds: string[];
  onToggleAll: () => void;
}

function SelectAllRow({
  query,
  selectAllState,
  visibleSelectableIds,
  onToggleAll,
}: SelectAllRowProps) {
  const { t } = useUiTranslation();
  const hasSelectable = visibleSelectableIds.length > 0;
  return (
    <label
      className={`flex shrink-0 items-center gap-2 px-1 text-[11px] text-muted-foreground ${
        hasSelectable ? "cursor-pointer" : "cursor-not-allowed opacity-50"
      }`}
    >
      <Checkbox
        checked={selectAllState}
        disabled={!hasSelectable}
        onCheckedChange={onToggleAll}
        aria-label={t(
          "conversation.importConversationList.selectAllVisibleConversations",
          "Select all visible conversations",
        )}
      />
      <span>
        {selectAllState === true
          ? t("conversation.importConversationList.unselectAll", "Unselect all")
          : t("conversation.importConversationList.selectAll", "Select all")}
        {query.trim() ? " matching" : ""}
        {hasSelectable ? ` (${visibleSelectableIds.length})` : ""}
      </span>
    </label>
  );
}

interface ConversationListPanelProps {
  conversations: ImportConversationSummary[];
  error: unknown;
  filtered: ImportConversationSummary[];
  isError: boolean;
  isLoading: boolean;
  onRefetch: () => Promise<unknown>;
  onToggle: (id: string) => void;
  providerLabel: string;
  selectedIds: ReadonlySet<string>;
}

function ConversationListPanel({
  conversations,
  error,
  filtered,
  isError,
  isLoading,
  onRefetch,
  onToggle,
  providerLabel,
  selectedIds,
}: ConversationListPanelProps) {
  const { t } = useUiTranslation();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
      {isLoading && <ListSkeleton />}
      {!isLoading && isError && (
        <EmptyState
          title={t(
            "conversation.importConversationList.couldnTLoadConversations",
            "Couldn't load conversations",
          )}
          description={apiErrorMessage(
            error,
            t("conversation.importConversationList.unknownError", "Unknown error"),
          )}
          actionLabel={t("conversation.importConversationList.retry", "Retry")}
          onAction={() => {
            void onRefetch();
          }}
        />
      )}
      {!isLoading && !isError && filtered.length === 0 && (
        <EmptyState
          title={
            conversations.length === 0
              ? t(
                  "conversation.importConversationList.noProviderConversations",
                  "No {{provider}} conversations found",
                  { provider: providerLabel },
                )
              : t(
                  "conversation.importConversationList.noMatchingConversations",
                  "No matching conversations",
                )
          }
          description={
            conversations.length === 0
              ? emptyProviderDescription(providerLabel, t)
              : t(
                  "conversation.importConversationList.tryADifferentSearchTerm",
                  "Try a different search term.",
                )
          }
        />
      )}
      {!isLoading && !isError && filtered.length > 0 && (
        <ul className="divide-y divide-border">
          {filtered.map((conversation) => (
            <ConversationRow
              key={conversation.source_session_id}
              conversation={conversation}
              checked={
                conversation.already_imported || selectedIds.has(conversation.source_session_id)
              }
              disabled={conversation.already_imported}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface ImportFooterProps {
  isImporting: boolean;
  onBack: () => void;
  onImport: () => void;
  selectedCount: number;
}

function ImportFooter({ isImporting, onBack, onImport, selectedCount }: ImportFooterProps) {
  const { t } = useUiTranslation();
  return (
    <div className="flex shrink-0 items-center justify-between gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        {t("conversation.importConversationList.back", "Back")}
      </Button>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          {t("conversation.importConversationList.selected", "{{count}} selected", {
            count: selectedCount,
          })}
        </span>
        <Button
          type="button"
          size="sm"
          onClick={onImport}
          disabled={selectedCount === 0 || isImporting}
        >
          {isImporting
            ? t("conversation.importConversationList.starting", "Starting…")
            : t("conversation.importConversationList.importSelection", "Import {{count}}", {
                count: selectedCount,
              })}
        </Button>
      </div>
    </div>
  );
}

interface ConversationRowProps {
  conversation: ImportConversationSummary;
  checked: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}

function ConversationRowInner({ conversation, checked, disabled, onToggle }: ConversationRowProps) {
  const { t, i18n } = useUiTranslation();
  return (
    <li>
      <label
        className={`flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/40 ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
      >
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={() => onToggle(conversation.source_session_id)}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{conversation.title}</div>
          <div className="text-[11px] text-muted-foreground">
            {t("conversation.importConversationList.messageCount", {
              count: conversation.message_count,
              defaultValue_zero: "{{count}} messages",
              defaultValue_one: "{{count}} message",
              defaultValue_other: "{{count}} messages",
            })}
            {conversation.modified_at
              ? ` · ${formatDate(conversation.modified_at, i18n.language)}`
              : ""}
            {conversation.already_imported
              ? t("conversation.importConversationList.alreadyImported", " · already imported")
              : ""}
          </div>
        </div>
      </label>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

function EmptyState({ title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
      <div className="text-sm font-medium">{title}</div>
      <p className="text-[11px] text-muted-foreground">{description}</p>
      {actionLabel && onAction && (
        <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

function formatDate(iso: string, locale: string | undefined): string {
  try {
    return new Date(iso).toLocaleString(locale);
  } catch {
    return iso;
  }
}

function emptyProviderDescription(providerLabel: string, t: UiTranslator): string {
  return t(
    "conversation.importConversationList.noLocalProviderSessions",
    "Looked in {{provider}}'s local session storage for this project's path. Run {{provider}} in this project's folder first.",
    { provider: providerLabel },
  );
}

const ConversationRow = memo(ConversationRowInner);
export const ImportConversationList = memo(ImportConversationListInner);

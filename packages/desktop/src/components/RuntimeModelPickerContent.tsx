import { useUiTranslation } from "@/lib/i18n/ui";
import { type RefObject } from "react";
import { StarIcon } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandList,
  useCommandState,
} from "@/components/ui/command";
import { AdaptivePopoverContent } from "@/components/PhoneSheetMenu";
import { useInPhoneSheet } from "@/components/PhoneSheet";
import { KBD_HINT_PROPS, ResolvedShortcutHint } from "@/components/KbdShortcut";
import { useShortcut } from "@/hooks/useShortcut";
import { cn } from "@/lib/utils";
import { revealPickerItem } from "./RuntimeModelPickerChrome";
import {
  CatalogRefreshNotices,
  ModelGroup,
  ProviderStateGroup,
  SelectionGroup,
} from "./RuntimeModelPickerSections";
import type { RuntimeModelPickerAction } from "./RuntimeModelPickerSections";
import {
  type CatalogRefreshNotice,
  isProviderCollapsed,
  modelPickerFilter,
  type ModelEntry,
  type ModelGroupSpec,
  type ProviderStateEntry,
} from "./runtimeModelPickerGroups";

interface FavoriteShortcutProps {
  onToggleHighlighted: () => void;
}

interface RuntimeModelPickerContentProps {
  action?: RuntimeModelPickerAction;
  align: "start" | "center" | "end";
  catalogNotices: CatalogRefreshNotice[];
  contentClassName?: string;
  emptyText: string;
  expandedGroupIds: ReadonlySet<string>;
  favorites: ReadonlySet<string>;
  inputRef: RefObject<HTMLInputElement | null>;
  isSearching: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  modelGroups: ModelGroupSpec[];
  needsCollapse: boolean;
  onActionSelect: () => void;
  onAfterSelectClose?: () => void;
  onCollapseGroup: (groupId: string) => void;
  onExpandGroup: (groupId: string) => void;
  onModelSelect: (entry: ModelEntry) => void;
  onToggleFavorite: (value: string) => void;
  onToggleHighlightedFavorite: () => void;
  providerStateEntries: ProviderStateEntry[];
  restoreFocusAfterCloseRef: RefObject<boolean>;
  search: string;
  searchPlaceholder: string;
  selectedCommandValue: string;
  selectedModelValue: string;
  setSearch: (value: string) => void;
}

const POPOVER_LIST_CLASS = "h-[320px] max-h-[320px]";
/** The phone sheet: the list takes the sheet's height, its rows 44px touch targets. */
const SHEET_LIST_CLASS = "max-h-none min-h-0 flex-1 [&_[cmdk-item]]:min-h-11";

let highlightFrame = 0;

function scrollHighlightedPickerItem(listRef: RefObject<HTMLDivElement | null>): void {
  cancelAnimationFrame(highlightFrame);
  highlightFrame = requestAnimationFrame(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]');
    if (item) revealPickerItem(list, item);
  });
}

function FavoriteShortcut({ onToggleHighlighted }: FavoriteShortcutProps): React.ReactNode {
  const { t } = useUiTranslation();
  const hasMatches = useCommandState((state) => state.filtered.count > 0);

  useShortcut(
    "model-picker-favorite",
    (event) => {
      event.preventDefault();
      onToggleHighlighted();
    },
    undefined,
    [onToggleHighlighted],
  );

  // A keyboard legend: the whole footer goes on touch, where stars are tapped.
  return (
    <div
      {...KBD_HINT_PROPS}
      className="flex h-8 items-center gap-1.5 border-t px-2.5 text-[11px] text-muted-foreground"
    >
      {hasMatches ? (
        <>
          <StarIcon className="size-3 shrink-0" />
          <span>
            {t("conversation.composer.runtimeModelPickerContent.starUnstar", "Star / unstar")}
          </span>
          <ResolvedShortcutHint shortcutId="model-picker-favorite" />
        </>
      ) : null}
    </div>
  );
}

export function RuntimeModelPickerContent({
  action,
  align,
  catalogNotices,
  contentClassName,
  emptyText,
  expandedGroupIds,
  favorites,
  inputRef,
  isSearching,
  listRef,
  modelGroups,
  needsCollapse,
  onActionSelect,
  onAfterSelectClose,
  onCollapseGroup,
  onExpandGroup,
  onModelSelect,
  onToggleFavorite,
  onToggleHighlightedFavorite,
  providerStateEntries,
  restoreFocusAfterCloseRef,
  search,
  searchPlaceholder,
  selectedCommandValue,
  selectedModelValue,
  setSearch,
}: RuntimeModelPickerContentProps): React.ReactElement {
  const { t } = useUiTranslation();
  const inSheet = useInPhoneSheet();
  // On phone the sheet never focuses the search field (that would raise the
  // keyboard over the list) and gives focus back to the model chip on close.
  return (
    <AdaptivePopoverContent
      sheetTitle={t("conversation.stream.modelMetaChip.model", "Model")}
      sheetClassName="min-h-0"
      align={align}
      className={cn(
        "flex w-[380px] max-h-[var(--radix-popper-available-height)] max-w-[calc(100vw-16px)] flex-col overflow-hidden p-0",
        contentClassName,
      )}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        requestAnimationFrame(() => inputRef.current?.focus());
      }}
      onCloseAutoFocus={(event) => {
        if (!restoreFocusAfterCloseRef.current) return;
        restoreFocusAfterCloseRef.current = false;
        event.preventDefault();
        onAfterSelectClose?.();
      }}
    >
      <Command
        className={inSheet ? "min-h-0 bg-transparent" : undefined}
        defaultValue={selectedCommandValue}
        filter={modelPickerFilter}
        onValueChange={() => scrollHighlightedPickerItem(listRef)}
      >
        <CommandInput
          ref={inputRef}
          placeholder={searchPlaceholder}
          value={search}
          onValueChange={setSearch}
          className={inSheet ? "h-11" : "h-9 text-xs"}
        />
        {catalogNotices.length > 0 ? <CatalogRefreshNotices notices={catalogNotices} /> : null}
        <CommandList ref={listRef} className={inSheet ? SHEET_LIST_CLASS : POPOVER_LIST_CLASS}>
          <CommandEmpty className="py-3 text-center text-xs">{emptyText}</CommandEmpty>
          {action ? <SelectionGroup action={action} onSelect={onActionSelect} /> : null}
          {modelGroups.map((group) => (
            <ModelGroup
              key={group.id}
              group={group}
              selectedModelValue={selectedModelValue}
              favorites={favorites}
              collapsed={isProviderCollapsed(group, expandedGroupIds, needsCollapse, isSearching)}
              canCollapse={group.collapsible && needsCollapse && !isSearching}
              expandedGroupIds={expandedGroupIds}
              needsCollapse={needsCollapse}
              isSearching={isSearching}
              onSelect={onModelSelect}
              onToggleFavorite={onToggleFavorite}
              onExpand={onExpandGroup}
              onCollapse={onCollapseGroup}
            />
          ))}
          {providerStateEntries.length > 0 ? (
            <ProviderStateGroup entries={providerStateEntries} />
          ) : null}
        </CommandList>
        {modelGroups.length > 0 ? (
          <FavoriteShortcut onToggleHighlighted={onToggleHighlightedFavorite} />
        ) : null}
      </Command>
    </AdaptivePopoverContent>
  );
}

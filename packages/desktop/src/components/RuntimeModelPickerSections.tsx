import { CheckIcon, HistoryIcon, LockIcon, StarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import { ProviderIcon } from "@/lib/provider-icons";
import { cn } from "@/lib/utils";
import {
  MODEL_INSET_CLASS,
  PICKER_GROUP_CLASS,
  PICKER_ITEM_CLASS,
  ProviderBrowseItem,
  ProviderHeader,
  VendorBrowseItem,
} from "./RuntimeModelPickerChrome";
import {
  type CatalogRefreshNotice,
  displayModelDescription,
  displayModelId,
  displayModelLabel,
  isVendorCollapsed,
  type ModelEntry,
  type ModelGroupSpec,
  type ProviderStateEntry,
  type VendorSection,
} from "./runtimeModelPickerGroups";

export interface RuntimeModelPickerAction {
  id: string;
  label: string;
  description?: string;
  selected: boolean;
  keywords?: string[];
  onSelect: () => void;
}

interface ModelGroupProps {
  group: ModelGroupSpec;
  selectedModelValue: string;
  favorites: ReadonlySet<string>;
  collapsed: boolean;
  canCollapse: boolean;
  expandedGroupIds: ReadonlySet<string>;
  needsCollapse: boolean;
  isSearching: boolean;
  onSelect: (entry: ModelEntry) => void;
  onToggleFavorite: (value: string) => void;
  onExpand: (groupId: string) => void;
  onCollapse: (groupId: string) => void;
}

export function SelectionGroup({
  action,
  onSelect,
}: {
  action: RuntimeModelPickerAction;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <CommandGroup heading="Selection" className={PICKER_GROUP_CLASS}>
      <CommandItem
        value={action.id}
        keywords={action.keywords}
        onSelect={onSelect}
        className={cn(
          PICKER_ITEM_CLASS,
          "flex items-start gap-2 whitespace-normal px-2.5 py-1.5 text-xs",
        )}
      >
        <CheckIcon
          className={cn(
            "mt-0.5 size-3 shrink-0 text-[var(--chip-violet-soft)]",
            action.selected ? "opacity-100" : "opacity-0",
          )}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="break-words text-foreground">{action.label}</span>
          {action.description ? (
            <span className="break-words text-[11px] text-muted-foreground">
              {action.description}
            </span>
          ) : null}
        </span>
      </CommandItem>
    </CommandGroup>
  );
}

export function ModelGroup({
  group,
  selectedModelValue,
  favorites,
  collapsed,
  canCollapse,
  expandedGroupIds,
  needsCollapse,
  isSearching,
  onSelect,
  onToggleFavorite,
  onExpand,
  onCollapse,
}: ModelGroupProps): React.ReactElement {
  if (collapsed) {
    return (
      <CommandGroup className="overflow-visible p-0">
        <ProviderBrowseItem group={group} onExpand={() => onExpand(group.id)} />
      </CommandGroup>
    );
  }

  return (
    <CommandGroup
      className={PICKER_GROUP_CLASS}
      heading={
        <ProviderHeader
          group={group}
          canCollapse={canCollapse}
          onCollapse={() => onCollapse(group.id)}
        />
      }
    >
      {group.vendors.map((vendor) => (
        <VendorBlock
          key={vendor.id}
          group={group}
          vendor={vendor}
          collapsed={isVendorCollapsed(group, vendor, expandedGroupIds, needsCollapse, isSearching)}
          selectedModelValue={selectedModelValue}
          favorites={favorites}
          showProviderIcon={group.kind === "starred"}
          showVendorHeading={!isSearching}
          onSelect={onSelect}
          onToggleFavorite={onToggleFavorite}
          onExpand={() => onExpand(vendor.id)}
        />
      ))}
    </CommandGroup>
  );
}

function VendorBlock({
  group,
  vendor,
  collapsed,
  selectedModelValue,
  favorites,
  showProviderIcon,
  showVendorHeading,
  onSelect,
  onToggleFavorite,
  onExpand,
}: {
  group: ModelGroupSpec;
  vendor: VendorSection;
  collapsed: boolean;
  selectedModelValue: string;
  favorites: ReadonlySet<string>;
  showProviderIcon: boolean;
  showVendorHeading: boolean;
  onSelect: (entry: ModelEntry) => void;
  onToggleFavorite: (value: string) => void;
  onExpand: () => void;
}): React.ReactElement {
  if (collapsed) {
    return <VendorBrowseItem group={group} vendor={vendor} onExpand={onExpand} />;
  }

  return (
    <>
      {showVendorHeading && vendor.heading ? (
        <div
          className={cn(
            MODEL_INSET_CLASS,
            "pb-1 pt-2.5 pr-2.5 text-[11px] font-medium text-muted-foreground",
          )}
        >
          {vendor.heading}
        </div>
      ) : null}
      {vendor.entries.map((entry) => (
        <ModelItem
          key={entry.value}
          entry={entry}
          vendorKey={vendor.vendorKey}
          isSelected={entry.value === selectedModelValue}
          isFavorite={favorites.has(entry.value)}
          showProviderIcon={showProviderIcon}
          onSelect={onSelect}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </>
  );
}

function ModelItem({
  entry,
  vendorKey,
  isSelected,
  isFavorite,
  showProviderIcon,
  onSelect,
  onToggleFavorite,
}: {
  entry: ModelEntry;
  vendorKey?: string;
  isSelected: boolean;
  isFavorite: boolean;
  showProviderIcon: boolean;
  onSelect: (entry: ModelEntry) => void;
  onToggleFavorite: (value: string) => void;
}): React.ReactElement {
  const visibleLabel = displayModelLabel(entry, vendorKey);
  const visibleId = displayModelId(entry, visibleLabel);
  const visibleDescription = displayModelDescription(entry, visibleLabel, visibleId);
  const accessibleName = showProviderIcon
    ? `${visibleLabel}, ${entry.providerLabel}`
    : visibleLabel;

  return (
    <CommandItem
      value={entry.value}
      keywords={entry.keywords}
      onSelect={() => onSelect(entry)}
      className={cn(
        showProviderIcon ? "px-2.5" : MODEL_INSET_CLASS,
        PICKER_ITEM_CLASS,
        "group/model flex items-start justify-between gap-2 rounded-none whitespace-normal py-1.5 pr-2.5 text-xs",
      )}
      title={entry.description ?? entry.modelId}
      aria-label={accessibleName}
    >
      <span className="flex min-w-0 items-start gap-2">
        {showProviderIcon ? (
          <ProviderIcon
            providerId={entry.providerId}
            alt=""
            className="mt-0.5 size-4 shrink-0 rounded-sm"
          />
        ) : null}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="break-words text-foreground">{visibleLabel}</span>
          {visibleDescription ? (
            <span className="break-words text-[11px] leading-snug text-muted-foreground">
              {visibleDescription}
            </span>
          ) : null}
          {visibleId ? (
            <span className="break-all font-mono text-[11px] leading-snug text-muted-foreground">
              {visibleId}
            </span>
          ) : null}
        </span>
      </span>
      <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
        <FavoriteToggle
          isFavorite={isFavorite}
          modelLabel={accessibleName}
          onToggle={() => onToggleFavorite(entry.value)}
        />
        <CheckIcon
          className={cn(
            "size-3 shrink-0 text-[var(--chip-violet-soft)]",
            isSelected ? "opacity-100" : "opacity-0",
          )}
        />
      </span>
    </CommandItem>
  );
}

function FavoriteToggle({
  isFavorite,
  modelLabel,
  onToggle,
}: {
  isFavorite: boolean;
  modelLabel: string;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={isFavorite}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "size-4 shrink-0 p-0",
        isFavorite
          ? "text-[var(--acc-yellow)]"
          : "text-muted-foreground opacity-0 group-hover/model:opacity-100 group-data-[selected=true]/model:opacity-100",
      )}
    >
      <StarIcon className={cn("size-3", isFavorite && "fill-current")} />
      <span className="sr-only">{`${isFavorite ? "Unstar" : "Star"} ${modelLabel}`}</span>
    </Button>
  );
}

/**
 * Quiet line per provider whose models are the last known catalog: the list
 * still works, but it may be out of date and the refresh failed for a reason.
 */
export function CatalogRefreshNotices({
  notices,
}: {
  notices: CatalogRefreshNotice[];
}): React.ReactElement {
  return (
    <div role="status" className="flex flex-col gap-1 border-b border-border/60 px-2.5 py-1.5">
      {notices.map((notice) => (
        <p
          key={notice.providerId}
          className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground"
          title={notice.reason}
        >
          <HistoryIcon className="mt-px size-3 shrink-0 text-[var(--acc-yellow)]" />
          <span className="min-w-0">
            <span className="text-foreground/80">
              {notice.providerLabel}: showing the last known models.
            </span>{" "}
            <span className="line-clamp-2 break-words">Refresh failed: {notice.reason}</span>
          </span>
        </p>
      ))}
    </div>
  );
}

export function ProviderStateGroup({
  entries,
}: {
  entries: ProviderStateEntry[];
}): React.ReactElement {
  return (
    <CommandGroup heading="Providers" className={PICKER_GROUP_CLASS}>
      {entries.map((entry) => (
        <CommandItem
          key={entry.value}
          value={entry.value}
          keywords={entry.keywords}
          disabled
          className={cn(
            PICKER_ITEM_CLASS,
            "flex items-start gap-2 whitespace-normal px-2.5 py-1.5 text-xs",
          )}
        >
          <LockIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="break-words text-muted-foreground">{entry.providerLabel}</span>
            <span className="break-words text-[11px] text-muted-foreground">
              {entry.statusLabel}
            </span>
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

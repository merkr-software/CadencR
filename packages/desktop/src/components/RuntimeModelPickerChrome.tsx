import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { ChevronDownIcon, ChevronRightIcon, StarIcon } from "lucide-react";
import { CommandItem } from "@/components/ui/command";
import { ProviderIcon } from "@/lib/provider-icons";
import { cn } from "@/lib/utils";
import {
  browseGroupValue,
  type ModelGroupSpec,
  type VendorSection,
} from "./runtimeModelPickerGroups";

export const PICKER_GROUP_CLASS =
  "overflow-visible p-0 [&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:m-0 [&_[cmdk-group-heading]]:border-b [&_[cmdk-group-heading]]:border-border/60 [&_[cmdk-group-heading]]:bg-[var(--popover-solid,var(--popover))] [&_[cmdk-group-heading]]:px-0 [&_[cmdk-group-heading]]:py-0 [&_[cmdk-group-heading]]:text-foreground";

/** Aligns model rows to the heading label after the provider logo. */
export const MODEL_INSET_CLASS = "pl-[34px]";

/** Keep arrow-key scrollIntoView from tucking the first row under a sticky heading. */
export const PICKER_ITEM_CLASS = "scroll-mt-9";

// In the phone layout the picker is a sheet: 44px touch rows.
const HEADING_ROW_CLASS = "flex min-h-8 w-full items-center gap-2 px-2.5 phone:min-h-11";

export function ProviderHeader({
  group,
  canCollapse,
  onCollapse,
}: {
  group: ModelGroupSpec;
  canCollapse: boolean;
  onCollapse: () => void;
}): React.ReactElement {
  const { t } = useUiTranslation();
  const lockup = <ProviderLockup group={group} expanded showChevron={canCollapse} />;
  if (!canCollapse) {
    return <div className={HEADING_ROW_CLASS}>{lockup}</div>;
  }

  return (
    <button
      type="button"
      aria-label={t(
        "conversation.composer.runtimeModelPickerChrome.collapse",
        "Collapse {{group}}",
        { group: group.heading },
      )}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onCollapse}
      className={cn(HEADING_ROW_CLASS, "cursor-default text-left hover:bg-accent/60")}
    >
      {lockup}
    </button>
  );
}

export function ProviderBrowseItem({
  group,
  onExpand,
}: {
  group: ModelGroupSpec;
  onExpand: () => void;
}): React.ReactElement {
  const { t } = useUiTranslation();
  const countLabel = modelCountLabel(t, group.entries.length);
  return (
    <CommandItem
      value={browseGroupValue(group.id)}
      keywords={[group.heading, group.providerId]}
      onSelect={onExpand}
      aria-label={t(
        "conversation.composer.runtimeModelPickerChrome.groupCount",
        "{{group}}, {{countLabel}}",
        { group: group.heading, countLabel },
      )}
      className={cn(
        HEADING_ROW_CLASS,
        PICKER_ITEM_CLASS,
        "rounded-none border-b border-border/60 py-0 text-xs [&_svg]:size-3",
      )}
    >
      <ProviderLockup group={group} expanded={false} showChevron />
    </CommandItem>
  );
}

export function VendorBrowseItem({
  group,
  vendor,
  onExpand,
}: {
  group: ModelGroupSpec;
  vendor: VendorSection;
  onExpand: () => void;
}): React.ReactElement {
  const { t } = useUiTranslation();
  const heading = vendor.heading ?? group.heading;
  const countLabel = modelCountLabel(t, vendor.entries.length);
  return (
    <CommandItem
      value={browseGroupValue(vendor.id)}
      keywords={[group.heading, group.providerId, vendor.heading ?? "", vendor.vendorKey ?? ""]}
      onSelect={onExpand}
      aria-label={t(
        "conversation.composer.runtimeModelPickerChrome.groupCount",
        "{{group}}, {{countLabel}}",
        { group: heading, countLabel },
      )}
      className={cn(
        MODEL_INSET_CLASS,
        PICKER_ITEM_CLASS,
        "flex items-center gap-2 rounded-none py-1.5 pr-2.5 text-xs [&_svg]:size-3",
      )}
    >
      <span className="min-w-0 flex-1 break-words text-muted-foreground">{heading}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{countLabel}</span>
      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/70" />
    </CommandItem>
  );
}

function ProviderLockup({
  group,
  expanded,
  showChevron,
}: {
  group: ModelGroupSpec;
  expanded: boolean;
  showChevron: boolean;
}): React.ReactElement {
  const { t } = useUiTranslation();
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <>
      <GroupMark group={group} />
      <span
        data-slot="picker-group-title"
        className="min-w-0 flex-1 break-words text-xs font-medium tracking-tight"
      >
        {group.heading}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {modelCountLabel(t, group.entries.length)}
      </span>
      {showChevron ? <Chevron className="size-3 shrink-0 text-muted-foreground/70" /> : null}
    </>
  );
}

function GroupMark({ group }: { group: ModelGroupSpec }): React.ReactElement {
  if (group.kind === "starred") {
    return <StarIcon className="size-4 shrink-0 text-[var(--acc-yellow)]" />;
  }
  return (
    <ProviderIcon providerId={group.providerId} alt="" className="size-4 shrink-0 rounded-sm" />
  );
}

function modelCountLabel(t: UiTranslator, count: number): string {
  return t("conversation.composer.runtimeModelPickerChrome.modelCount", "{{count}} models", {
    count,
    defaultValue_zero: "{{count}} models",
    defaultValue_one: "{{count}} model",
    defaultValue_other: "{{count}} models",
  });
}

/** cmdk uses `block: "nearest"`, which treats a row tucked under a sticky heading as visible. */
export function revealPickerItem(list: HTMLElement, item: HTMLElement): void {
  const heading = item.closest("[cmdk-group]")?.querySelector<HTMLElement>("[cmdk-group-heading]");
  const headerHeight = heading?.getBoundingClientRect().height ?? 0;
  const listRect = list.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const covered = headerHeight - (itemRect.top - listRect.top);
  if (covered > 1) {
    list.scrollTop -= covered;
    return;
  }
  const overflow = itemRect.bottom - listRect.bottom;
  if (overflow > 1) {
    list.scrollTop += overflow;
  }
}

import {
  useId,
  useMemo,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { ChevronRight, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HintTooltip } from "@/components/HintTooltip";
import { UsageSegmentedControl } from "@/components/usage/UsageSegmentedControl";
import { SidebarConfiguratorSteps } from "@/components/SidebarConfiguratorSteps";
import {
  SECTION_ORDER_DESCRIPTION,
  SidebarSectionOrderList,
} from "@/components/SidebarSectionOrder";
import {
  ROW_ELEMENTS,
  ROW_ELEMENTS_DESCRIPTION,
  type ChoiceId,
  type ChoiceRow,
} from "@/components/sidebar-display-rows";
import {
  DISPLAY_GROUPS,
  resolveDisplayItem,
  type DisplayGroup,
  type DisplayItem,
} from "@/components/sidebar-display-groups";
import { useSidebarOptionHighlight } from "@/hooks/useSidebarOptionHighlight";
import { nearestSidebarPreset } from "@/lib/sidebar-presets";
import type { SidebarOptionId } from "@/lib/sidebar-config";
import {
  useSetSidebarOption,
  useSidebarConfigWrites,
  useSidebarSettings,
} from "@/hooks/useSidebarSettings";
import { cn } from "@/lib/utils";

/** State and actions shared by the popover form and the Settings section. */
export function useSidebarDisplayForm() {
  const { config, isFetched } = useSidebarSettings();
  const setOption = useSetSidebarOption();
  const { reset, applyPreset, restore, isApplying } = useSidebarConfigWrites();
  return useMemo(
    () => ({
      config,
      /** The preset the options are, or moved from: the base the configurator adjusts. */
      nearest: nearestSidebarPreset(config),
      setOption,
      reset,
      applyPreset,
      restore,
      isApplying,
      disabled: !isFetched || isApplying,
    }),
    [config, setOption, reset, applyPreset, restore, isApplying, isFetched],
  );
}

export type SidebarDisplayForm = ReturnType<typeof useSidebarDisplayForm>;

export function ChoiceControl<K extends ChoiceId>({
  form,
  row,
}: {
  form: SidebarDisplayForm;
  row: ChoiceRow<K>;
}): ReactElement {
  if (row.control === "select") {
    return (
      <Select
        value={form.config[row.id]}
        onValueChange={(value) => {
          const option = row.options.find((candidate) => candidate.value === value);
          if (option) form.setOption(row.id, option.value);
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label={row.label}
          className="h-7 min-w-28 gap-1 px-2 py-0.5 text-[11px] data-[size=sm]:h-7 [&_svg:not([class*='size-'])]:size-3.5"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {row.options.map((option) => (
            <SelectItem key={option.value} value={option.value} className="text-[11px]">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <UsageSegmentedControl
      ariaLabel={row.label}
      value={form.config[row.id]}
      options={row.options}
      onChange={(value) => form.setOption(row.id, value)}
    />
  );
}

/** The per-row element checkboxes, two columns. */
export function RowElementGrid({
  form,
  className,
}: {
  form: SidebarDisplayForm;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("grid grid-cols-2", className)}>
      {ROW_ELEMENTS.map((element) => (
        <RowElementToggle
          key={element.id}
          option={element.id}
          label={element.label}
          hint={element.description}
          checked={form.config[element.id]}
          onChange={(checked) => form.setOption(element.id, checked)}
        />
      ))}
    </div>
  );
}

/** Reset, with a loader while the options load or the reset is in flight. */
export function ResetDisplayOptionsButton({
  form,
  ...buttonProps
}: { form: SidebarDisplayForm } & Pick<
  ComponentProps<typeof Button>,
  "variant" | "size" | "className" | "title"
>): ReactElement {
  return (
    <Button {...buttonProps} onClick={form.reset}>
      {form.disabled ? (
        <LoaderCircle
          className="animate-spin"
          aria-label={form.isApplying ? "Applying" : "Loading options"}
        />
      ) : (
        <RotateCcw />
      )}
      Reset
    </Button>
  );
}

/**
 * Every sidebar display option, applied live, in the popover's compact layout.
 * The Settings page lays the same options out as settings rows.
 */
export function SidebarDisplayOptionsForm({ className }: { className?: string }): ReactElement {
  const form = useSidebarDisplayForm();
  const highlight = useSidebarOptionHighlight();
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [essentials, ...folded] = DISPLAY_GROUPS;
  const toggleGroup = (id: string): void =>
    setOpenGroups((prior) => {
      const next = new Set(prior);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <fieldset
      disabled={form.disabled}
      className={cn("flex flex-col gap-3", className)}
      {...highlight}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold tracking-tight">Display options</span>
        <ResetDisplayOptionsButton
          form={form}
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          title="Restore every display option to its default"
        />
      </div>
      <SidebarConfiguratorSteps form={form}>
        <TooltipProvider delayDuration={300}>
          {essentials && <GroupItems form={form} group={essentials} />}
          {folded.map((group) => (
            <div key={group.id} className="flex flex-col gap-3 border-t border-border/50 pt-1.5">
              <button
                type="button"
                aria-expanded={openGroups.has(group.id)}
                onClick={() => toggleGroup(group.id)}
                className="-mx-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-foreground/80 outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50"
              >
                {group.label}
                <ChevronRight
                  className={cn(
                    "ml-auto size-3.5 text-muted-foreground transition-transform duration-150",
                    openGroups.has(group.id) && "rotate-90",
                  )}
                />
              </button>
              {openGroups.has(group.id) && <GroupItems form={form} group={group} />}
            </div>
          ))}
        </TooltipProvider>
      </SidebarConfiguratorSteps>
    </fieldset>
  );
}

function GroupItems({
  form,
  group,
}: {
  form: SidebarDisplayForm;
  group: DisplayGroup;
}): ReactElement {
  const switchId = useId();
  return (
    <>
      {group.items.map((item) => (
        <DisplayItemRow key={item} form={form} item={item} switchId={switchId} />
      ))}
    </>
  );
}

/** One option in the popover's compact layout, its description in a tooltip. */
function DisplayItemRow({
  form,
  item,
  switchId,
}: {
  form: SidebarDisplayForm;
  item: DisplayItem;
  switchId: string;
}): ReactElement {
  const resolved = resolveDisplayItem(item);
  if (resolved.kind === "sectionOrder") {
    return (
      <div data-sidebar-option="sectionOrder" className="flex flex-col gap-1.5">
        <HintLabel hint={SECTION_ORDER_DESCRIPTION} className="self-start">
          Block order
        </HintLabel>
        <SidebarSectionOrderList form={form} />
      </div>
    );
  }
  if (resolved.kind === "rowElements") {
    return (
      <div className="flex flex-col gap-1.5">
        <HintLabel hint={ROW_ELEMENTS_DESCRIPTION} className="self-start">
          Show in rows
        </HintLabel>
        <RowElementGrid form={form} className="gap-x-3 gap-y-1.5" />
      </div>
    );
  }
  if (resolved.kind === "choice") {
    const { row } = resolved;
    return (
      <OptionRow option={row.id} label={row.label} hint={row.description}>
        <ChoiceControl form={form} row={row} />
      </OptionRow>
    );
  }
  const { row } = resolved;
  const id = `${switchId}-${row.id}`;
  return (
    <OptionRow option={row.id} label={row.label} hint={row.description} htmlFor={id}>
      <Switch
        id={id}
        size="sm"
        checked={form.config[row.id]}
        aria-description={row.description}
        onCheckedChange={(checked) => form.setOption(row.id, checked)}
      />
    </OptionRow>
  );
}

/**
 * An option's name, explained in a tooltip on hover: the popover has no room
 * for the descriptions the Settings page shows under each row.
 */
function HintLabel({
  hint,
  htmlFor,
  className,
  children,
}: {
  hint: string;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <HintTooltip hint={hint} align="start">
      <label
        htmlFor={htmlFor}
        className={cn(
          "cursor-help text-xs text-muted-foreground transition-colors hover:text-foreground",
          className,
        )}
      >
        {children}
      </label>
    </HintTooltip>
  );
}

function OptionRow({
  option,
  label,
  hint,
  htmlFor,
  children,
}: {
  /** The option it sets, outlined in the sidebar while pointed at. */
  option?: SidebarOptionId;
  label: string;
  hint: string;
  htmlFor?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div data-sidebar-option={option} className="flex items-center justify-between gap-3">
      <HintLabel hint={hint} htmlFor={htmlFor}>
        {label}
      </HintLabel>
      {children}
    </div>
  );
}

function RowElementToggle({
  option,
  label,
  hint,
  checked,
  onChange,
}: {
  option: SidebarOptionId;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): ReactElement {
  const id = useId();
  return (
    <div data-sidebar-option={option} className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        aria-description={hint}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <HintLabel hint={hint} htmlFor={id} className="text-foreground/90">
        {label}
      </HintLabel>
    </div>
  );
}

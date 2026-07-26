import {
  useCallback,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  useFilteredVirtualList,
  type FilteredVirtualListRowContext,
} from "@/hooks/useFilteredVirtualList";
import { cn } from "@/lib/utils";

export interface PickerOption {
  value: number;
  label: string;
  /** Leading mark — the project badge, when the option is a project. */
  icon?: ReactNode;
}

export interface SchedulePickerProps {
  /** Names the trigger for assistive tech; also the visible field label. */
  ariaLabel: string;
  options: PickerOption[];
  value?: number | null;
  /** Shown when `value` isn't in `options` — e.g. an archived conversation. */
  fallbackLabel?: string | null;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  onChange: (value: number) => void;
}

/**
 * The searchable picker used for both halves of a schedule's target.
 *
 * A plain `Select` is fine for three projects and unusable for eighty
 * conversations, which is the realistic case — so both fields filter as you
 * type. The conversation list grows with the user's own history, so the rows
 * are virtualized (`frontend-performance.md`) through `useFilteredVirtualList`
 * — the same primitive `BranchPicker` renders. cmdk isn't used here because its
 * filtering and keyboard handling both assume every row is mounted.
 */
export function SchedulePicker({
  ariaLabel,
  options,
  value,
  fallbackLabel,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  onChange,
}: SchedulePickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.value === value);
  const label = selected?.label ?? fallbackLabel;

  const pick = useCallback(
    (option: PickerOption) => {
      onChange(option.value);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.icon}
            <span className={cn("truncate", !label && "text-muted-foreground")}>
              {label ?? placeholder}
            </span>
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          window.setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <PickerBody
          ariaLabel={ariaLabel}
          options={options}
          value={value}
          searchPlaceholder={searchPlaceholder}
          emptyLabel={emptyLabel}
          onPick={pick}
          inputRef={inputRef}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Matches the old `max-h-56`, and gives Virtuoso the bounded height it needs. */
const LIST_HEIGHT = 224;

/** `py-1.5` + `text-sm` — passed as `rowHeight` so a two-result list renders a
 *  two-row popover rather than 224px with a gap under it. */
const ROW_HEIGHT = 32;

const getOptionLabel = (option: PickerOption): string => option.label;

/**
 * The popover's contents. Split out both to keep `SchedulePicker` within the
 * per-function line budget and because Radix unmounts it on close — which is
 * what makes the search box empty again the next time the picker is opened,
 * with no reset to remember to write.
 */
function PickerBody({
  ariaLabel,
  options,
  value,
  searchPlaceholder,
  emptyLabel,
  onPick,
  inputRef,
}: {
  ariaLabel: string;
  options: PickerOption[];
  value?: number | null;
  searchPlaceholder: string;
  emptyLabel: string;
  onPick: (option: PickerOption) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}): ReactElement {
  const [query, setQuery] = useState("");
  const listId = useId();
  const rowId = useCallback((index: number) => `${listId}-option-${index}`, [listId]);

  const renderRow = useCallback(
    ({ item, index, isActive, open }: FilteredVirtualListRowContext<PickerOption>) => (
      <PickerRow
        id={rowId(index)}
        option={item}
        isActive={isActive}
        isSelected={item.value === value}
        onSelect={open}
      />
    ),
    [rowId, value],
  );

  const { list, onKeyDown, filteredCount, activeIndex } = useFilteredVirtualList<PickerOption>({
    items: options,
    query,
    getLabel: getOptionLabel,
    onPick,
    renderRow,
    height: LIST_HEIGHT,
    rowHeight: ROW_HEIGHT,
    emptyState: <p className="py-3 text-center text-xs text-muted-foreground">{emptyLabel}</p>,
  });

  return (
    <div className="flex flex-col">
      <div className="border-b px-2 pb-1.5 pt-2">
        <Input
          ref={inputRef}
          variant="ghost"
          role="combobox"
          aria-label={`Search ${ariaLabel.toLowerCase()}`}
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={filteredCount > 0 ? rowId(activeIndex) : undefined}
          placeholder={searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-7 text-sm"
        />
      </div>
      {/* Virtuoso injects wrappers between the viewport and the rows, so the
          options are named by `aria-owns` rather than DOM containment. */}
      <div id={listId} role="listbox" aria-label={ariaLabel}>
        {list}
      </div>
    </div>
  );
}

function PickerRow({
  id,
  option,
  isActive,
  isSelected,
  onSelect,
}: {
  id: string;
  option: PickerOption;
  isActive: boolean;
  isSelected: boolean;
  onSelect: () => void;
}): ReactElement {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={isSelected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none",
        isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      {option.icon}
      <span className="flex-1 truncate">{option.label}</span>
      {isSelected && <CheckIcon className="size-3.5 shrink-0" />}
    </button>
  );
}

/** Stands in for the picker when there is nothing to pick from yet. */
export function PickerPlaceholder({
  children,
  className,
  ...props
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div
      className={cn(
        "flex h-8 items-center gap-2 rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

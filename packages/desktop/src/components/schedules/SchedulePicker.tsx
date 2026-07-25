import { useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
 * type, the same shape the model and profile pickers use.
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
        <Command shouldFilter>
          <CommandInput
            ref={inputRef}
            aria-label={`Search ${ariaLabel.toLowerCase()}`}
            placeholder={searchPlaceholder}
            className="h-9 text-sm"
          />
          <CommandList className="max-h-56">
            <CommandEmpty className="py-3 text-center text-xs">{emptyLabel}</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                // cmdk filters on `value`, so the id rides along with the label
                // to keep two same-named rows selectable.
                value={`${option.label} ${option.value}`}
                className="text-sm"
                onSelect={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.icon}
                <span className="flex-1 truncate">{option.label}</span>
                {option.value === value && <CheckIcon className="size-3.5" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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

import { memo, useMemo, useRef, useState, type ReactElement } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type { ClaudeCodeProfile } from "@/api/agentRuntime";
import { DEFAULT_CLAUDE_PROFILE_NAME, formatClaudeProfileLabel } from "@/lib/claude-profiles";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface ClaudeProfileComboboxProps {
  value: string;
  profiles: ClaudeCodeProfile[];
  isLoading: boolean;
  isError: boolean;
  onChange: (profile: string) => void;
  triggerClassName?: string;
  /** `instrument`: the composer card's instrument row (the schedule editor). */
  variant?: "default" | "instrument";
  label?: string;
  /**
   * The globally configured active profile (Settings → Agents), which is a
   * different thing from `value`: picking here only scopes the next prompt and
   * never mutates the active profile. Passing it badges that row so "active"
   * and "selected for this session" stop looking like the same state.
   */
  activeProfile?: string;
}

export const ClaudeProfileCombobox = memo(function ClaudeProfileCombobox({
  value,
  profiles,
  isLoading,
  isError,
  onChange,
  triggerClassName,
  variant = "default",
  label,
  activeProfile,
}: ClaudeProfileComboboxProps): ReactElement {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const options = useProfileOptions(profiles);
  const selectedLabel =
    options.find((option) => option.value === value)?.label ?? formatClaudeProfileLabel(value);

  if (isLoading) {
    return (
      <span className={loadingClassName(variant)} aria-busy="true">
        Loading profiles…
      </span>
    );
  }

  if (isError) {
    return <span className="text-[11px] text-destructive">Failed to load profiles</span>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label="Profile"
          aria-expanded={open}
          title={`Profile: ${selectedLabel}`}
          className={cn(triggerBaseClassName(variant), triggerClassName)}
        >
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {label && <span className="text-muted-foreground/80">{label}</span>}
            <span className="truncate">{selectedLabel}</span>
          </span>
          <ChevronDownIcon className="size-3 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side={variant === "instrument" ? "top" : undefined}
        className="w-64 overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          window.setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <Command shouldFilter label="Search profiles">
          <CommandInput
            ref={inputRef}
            aria-label="Search profiles"
            placeholder="Search profiles…"
            className="h-9 text-xs"
          />
          <CommandList className="max-h-48">
            <CommandEmpty className="py-3 text-center text-xs">No matching profiles.</CommandEmpty>
            <CommandGroup heading="Profiles">
              {options.map((profile) => {
                const selected = profile.value === value;
                return (
                  <CommandItem
                    key={profile.value}
                    value={profile.value}
                    keywords={[profile.label]}
                    className={cn("text-xs", selected && "font-medium text-foreground")}
                    onSelect={() => {
                      onChange(profile.value);
                      setOpen(false);
                    }}
                  >
                    <span className="flex-1 truncate">{profile.label}</span>
                    {profile.value === activeProfile && (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                        Active
                      </Badge>
                    )}
                    {selected && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
});

function triggerBaseClassName(variant: "default" | "instrument"): string {
  if (variant === "instrument") {
    return "composer-instrument min-w-0 max-w-[180px] shrink gap-1.5 overflow-hidden text-foreground/85 [&_svg]:size-3 [&_svg]:opacity-50";
  }
  // Filled, not `bg-transparent`: this variant renders on the session-info
  // popover, where a transparent trigger reads as text rather than a control.
  return "inline-flex h-8 min-w-32 items-center justify-between gap-2 whitespace-nowrap rounded-md border border-border bg-muted/40 px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
}

function loadingClassName(variant: "default" | "instrument"): string {
  if (variant === "instrument") return "composer-instrument text-muted-foreground";
  return "text-[11px] text-muted-foreground";
}

interface ProfileOption {
  value: string;
  label: string;
}

function useProfileOptions(profiles: ClaudeCodeProfile[]): ProfileOption[] {
  return useMemo(() => {
    const seen = new Set<string>([DEFAULT_CLAUDE_PROFILE_NAME]);
    const options: ProfileOption[] = [
      {
        value: DEFAULT_CLAUDE_PROFILE_NAME,
        label: formatClaudeProfileLabel(DEFAULT_CLAUDE_PROFILE_NAME),
      },
    ];
    profiles.forEach((profile) => {
      if (seen.has(profile.name)) return;
      seen.add(profile.name);
      options.push({
        value: profile.name,
        label: profile.label ?? formatClaudeProfileLabel(profile.name),
      });
    });
    return options;
  }, [profiles]);
}

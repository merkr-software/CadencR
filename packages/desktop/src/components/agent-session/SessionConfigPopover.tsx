import { AlertCircle, Loader2, RefreshCw, SlidersHorizontal } from "lucide-react";
import type {
  RuntimeSessionConfigOption,
  RuntimeSessionConfigSelectOption,
  RuntimeSessionConfigSnapshot,
  RuntimeSessionConfigValue,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { META_BAR_CHIP } from "./meta-bar-chip-styles";

interface SessionConfigPopoverProps {
  config: RuntimeSessionConfigSnapshot | null;
  loading: boolean;
  supported: boolean | null;
  error: string | null;
  pendingId: string | null;
  onRefresh: () => void;
  onChange: (configId: string, value: RuntimeSessionConfigValue) => void;
}

export function SessionConfigPopover({
  config,
  loading,
  supported,
  error,
  pendingId,
  onRefresh,
  onChange,
}: SessionConfigPopoverProps): React.JSX.Element | null {
  if (supported === false) return null;
  const options = config?.options.filter((option) => !isDedicatedControl(option)) ?? [];
  if (!loading && !error && options.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(META_BAR_CHIP, error && "text-destructive")}
          aria-label="Session configuration"
          title="Configuration negotiated with this ACP provider"
        >
          {loading ? <Loader2 className="animate-spin" /> : <SlidersHorizontal />}
          Session
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-[360px] max-w-[calc(100vw-2rem)] space-y-3 p-3"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div>
          <p className="text-sm font-semibold">Session configuration</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Additional controls from the active ACP session. Model and thinking use the main session
            controls so every change remains durable.
          </p>
        </div>
        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading configuration…
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="rounded-md border border-destructive/30 p-2 text-xs">
            <p className="flex gap-2 text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" /> {error}
            </p>
            <Button size="xs" variant="outline" className="mt-2" onClick={onRefresh}>
              <RefreshCw /> Retry
            </Button>
          </div>
        ) : null}
        {options.length > 0 ? (
          <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
            {options.map((option) => (
              <SessionConfigField
                key={option.id}
                option={option}
                pending={pendingId === option.id}
                disabled={pendingId !== null}
                onChange={onChange}
              />
            ))}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function isDedicatedControl(option: RuntimeSessionConfigOption): boolean {
  return option.category === "model" || option.category === "thought_level";
}

function SessionConfigField({
  option,
  pending,
  disabled,
  onChange,
}: {
  option: RuntimeSessionConfigOption;
  pending: boolean;
  disabled: boolean;
  onChange: (configId: string, value: RuntimeSessionConfigValue) => void;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/60 p-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <label htmlFor={`session-config-${option.id}`} className="text-xs font-medium">
              {option.name}
            </label>
            {option.category ? (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                {option.category}
              </span>
            ) : null}
          </div>
          {option.description ? (
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {option.description}
            </p>
          ) : null}
        </div>
        {pending ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" /> : null}
      </div>
      <div className="mt-2">
        {option.type === "boolean" ? (
          <Switch
            id={`session-config-${option.id}`}
            checked={option.current_value}
            disabled={disabled}
            onCheckedChange={(value) => onChange(option.id, value)}
          />
        ) : (
          <SessionConfigSelect option={option} disabled={disabled} onChange={onChange} />
        )}
      </div>
    </div>
  );
}

function SessionConfigSelect({
  option,
  disabled,
  onChange,
}: {
  option: Extract<RuntimeSessionConfigOption, { type: "select" }>;
  disabled: boolean;
  onChange: (configId: string, value: RuntimeSessionConfigValue) => void;
}): React.JSX.Element {
  const choices = flattenChoices(option);
  return (
    <Select
      value={option.current_value}
      disabled={disabled}
      onValueChange={(value) => onChange(option.id, value)}
    >
      <SelectTrigger id={`session-config-${option.id}`} size="sm" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {choices.map(({ option: choice, group }) => (
          <SelectItem key={`${group ?? ""}:${choice.value}`} value={choice.value}>
            <span className="min-w-0">
              {group ? <span className="mr-1 text-muted-foreground">{group} ·</span> : null}
              {choice.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function flattenChoices(
  option: Extract<RuntimeSessionConfigOption, { type: "select" }>,
): Array<{ option: RuntimeSessionConfigSelectOption; group?: string }> {
  if (option.choices.layout === "ungrouped") {
    return option.choices.options.map((choice) => ({ option: choice }));
  }
  return option.choices.groups.flatMap((group) =>
    group.options.map((choice) => ({ option: choice, group: group.name })),
  );
}

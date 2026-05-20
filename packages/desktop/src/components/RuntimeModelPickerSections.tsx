import { CheckIcon, LockIcon } from "lucide-react";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import { ProviderIcon } from "@/lib/provider-icons";
import { cn } from "@/lib/utils";
import type { RuntimeModelPickerProvider } from "./RuntimeModelPicker";

export interface RuntimeModelPickerAction {
  id: string;
  label: string;
  description?: string;
  selected: boolean;
  keywords?: string[];
  onSelect: () => void;
}

export interface ModelEntry {
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  description?: string;
  value: string;
  keywords: string[];
}

export interface ProviderStateEntry {
  providerId: string;
  providerLabel: string;
  statusLabel: string;
  value: string;
  keywords: string[];
}

interface SelectionGroupProps {
  action: RuntimeModelPickerAction;
  onSelect: () => void;
}

interface ModelGroupProps {
  entries: ModelEntry[];
  selectedModelValue: string;
  onSelect: (entry: ModelEntry) => void;
}

interface ModelItemProps {
  entry: ModelEntry;
  isSelected: boolean;
  onSelect: (entry: ModelEntry) => void;
}

interface ProviderStateGroupProps {
  entries: ProviderStateEntry[];
}

export function getModelEntries(providers: RuntimeModelPickerProvider[]): ModelEntry[] {
  return providers.flatMap((provider) => {
    if (provider.disabled || provider.models.length === 0) return [];
    return provider.models.map((model) => ({
      providerId: provider.id,
      providerLabel: provider.label,
      modelId: model.id,
      modelLabel: model.label,
      description: model.description,
      value: `${provider.id}:${model.id}`,
      keywords: [provider.label, provider.id, model.label, model.id, model.description ?? ""],
    }));
  });
}

export function getProviderStateEntries(
  providers: RuntimeModelPickerProvider[],
): ProviderStateEntry[] {
  return providers.flatMap((provider) => {
    if (!provider.disabled && provider.models.length > 0) return [];
    const statusLabel = getProviderStatusLabel(provider);
    return [
      {
        providerId: provider.id,
        providerLabel: provider.label,
        statusLabel,
        value: `${provider.id}:state`,
        keywords: [provider.label, provider.id, statusLabel],
      },
    ];
  });
}

function getProviderStatusLabel(provider: RuntimeModelPickerProvider): string {
  if (!provider.disabled) return "No models available";
  if (provider.status === "unavailable") return provider.statusMessage ?? "Unavailable";
  return "Coming soon";
}

export function SelectionGroup({ action, onSelect }: SelectionGroupProps): React.ReactElement {
  return (
    <CommandGroup heading="Selection">
      <CommandItem
        value={action.id}
        keywords={action.keywords}
        onSelect={onSelect}
        className="flex items-start gap-2 text-xs"
      >
        <CheckIcon
          className={cn("mt-0.5 size-3 shrink-0", action.selected ? "opacity-100" : "opacity-0")}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-foreground">{action.label}</span>
          {action.description ? (
            <span className="truncate text-[11px] text-muted-foreground">{action.description}</span>
          ) : null}
        </span>
      </CommandItem>
    </CommandGroup>
  );
}

export function ModelGroup({
  entries,
  selectedModelValue,
  onSelect,
}: ModelGroupProps): React.ReactElement {
  return (
    <CommandGroup heading="Models">
      {entries.map((entry) => (
        <ModelItem
          key={entry.value}
          entry={entry}
          isSelected={entry.value === selectedModelValue}
          onSelect={onSelect}
        />
      ))}
    </CommandGroup>
  );
}

function ModelItem({ entry, isSelected, onSelect }: ModelItemProps): React.ReactElement {
  return (
    <CommandItem
      value={entry.value}
      keywords={entry.keywords}
      onSelect={() => onSelect(entry)}
      className="flex items-start justify-between gap-2 text-xs"
      title={entry.description}
    >
      <span className="flex min-w-0 items-start gap-2">
        <ProviderIcon
          providerId={entry.providerId}
          alt={entry.modelLabel}
          className="mt-0.5 size-3.5 shrink-0 rounded-sm"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-foreground">
            {entry.providerLabel} / {entry.modelLabel}
          </span>
          {entry.description ? (
            <span className="truncate text-[11px] text-muted-foreground">{entry.description}</span>
          ) : null}
        </span>
      </span>
      <CheckIcon
        className={cn(
          "mt-0.5 size-3 shrink-0 text-violet-400",
          isSelected ? "opacity-100" : "opacity-0",
        )}
      />
    </CommandItem>
  );
}

export function ProviderStateGroup({ entries }: ProviderStateGroupProps): React.ReactElement {
  return (
    <CommandGroup heading="Providers">
      {entries.map((entry) => (
        <CommandItem
          key={entry.value}
          value={entry.value}
          keywords={entry.keywords}
          disabled
          className="flex items-start gap-2 text-xs"
        >
          <LockIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-muted-foreground">{entry.providerLabel}</span>
            <span className="truncate text-[11px] text-muted-foreground">{entry.statusLabel}</span>
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

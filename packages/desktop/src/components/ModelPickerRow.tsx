import { useUiTranslation } from "@/lib/i18n/ui";
import { useState } from "react";
import { Button } from "./ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/lib/provider-icons";

const INHERIT_VALUE = "__inherit__";

interface ModelOption {
  id: string;
  label: string;
  providerId?: string;
}

interface ModelPickerRowProps {
  label: React.ReactNode;
  models: ModelOption[];
  currentValue: string;
  effectiveModel: string;
  showInherit: boolean;
  onSelect: (value: string) => void;
}

export { INHERIT_VALUE };

interface ModelOptionsProps {
  currentValue: string;
  effectiveModel: string;
  models: ModelOption[];
  onSelect: (value: string) => void;
  showInherit: boolean;
}

function ModelOptions({
  currentValue,
  effectiveModel,
  models,
  onSelect,
  showInherit,
}: ModelOptionsProps): React.ReactElement {
  const { t } = useUiTranslation();
  const effectiveModelLabel = models.find((model) => model.id === effectiveModel)?.label;
  return (
    <CommandList>
      <CommandEmpty className="py-2 text-center text-xs">
        {t("conversation.composer.modelPickerRow.noOptionFound", "No option found.")}
      </CommandEmpty>
      <CommandGroup>
        {showInherit && (
          <CommandItem
            value={INHERIT_VALUE}
            onSelect={() => onSelect(INHERIT_VALUE)}
            className="text-xs"
          >
            <CheckIcon
              className={cn(
                "mr-2 size-3",
                currentValue === INHERIT_VALUE ? "opacity-100" : "opacity-0",
              )}
            />
            {t("conversation.composer.modelPickerRow.inheritModel", "Inherit ({{model}})", {
              model: effectiveModelLabel ?? effectiveModel,
            })}
          </CommandItem>
        )}
        {models.map((model) => (
          <CommandItem
            key={model.id}
            value={model.id}
            keywords={[model.label]}
            onSelect={() => onSelect(model.id)}
            className="text-xs"
          >
            <CheckIcon
              className={cn("mr-2 size-3", currentValue === model.id ? "opacity-100" : "opacity-0")}
            />
            <span className="flex items-center gap-2">
              <ProviderIcon
                providerId={model.providerId}
                alt={model.label}
                className="size-3.5 rounded-sm"
              />
              {model.label}
            </span>
          </CommandItem>
        ))}
      </CommandGroup>
    </CommandList>
  );
}

export function ModelPickerRow({
  label,
  models,
  currentValue,
  effectiveModel,
  showInherit,
  onSelect,
}: ModelPickerRowProps) {
  const { t } = useUiTranslation();
  const [open, setOpen] = useState(false);

  function getModelLabel(modelId: string): string {
    return models.find((m) => m.id === modelId)?.label ?? modelId;
  }

  function getModelProvider(modelId: string): string | undefined {
    return models.find((m) => m.id === modelId)?.providerId;
  }

  const displayLabel =
    currentValue === INHERIT_VALUE
      ? t("conversation.composer.modelPickerRow.inheritModel", "Inherit ({{model}})", {
          model: getModelLabel(effectiveModel),
        })
      : getModelLabel(currentValue);

  function handleSelect(value: string): void {
    onSelect(value);
    setOpen(false);
  }

  return (
    <div className="flex items-center gap-3">
      <label className="flex w-24 shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            className="h-7 flex-1 justify-between px-2 text-xs font-normal"
          >
            <span className="flex min-w-0 items-center gap-2 truncate">
              {currentValue !== INHERIT_VALUE && (
                <ProviderIcon
                  providerId={getModelProvider(currentValue)}
                  alt={displayLabel}
                  className="size-3.5 shrink-0 rounded-sm"
                />
              )}
              <span className="truncate">{displayLabel}</span>
            </span>
            <ChevronsUpDownIcon className="ml-1 size-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            <CommandInput
              placeholder={t(
                "conversation.composer.modelPickerRow.searchOptions",
                "Search options...",
              )}
              className="h-8 text-xs"
            />
            <ModelOptions
              currentValue={currentValue}
              effectiveModel={effectiveModel}
              models={models}
              onSelect={handleSelect}
              showInherit={showInherit}
            />
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

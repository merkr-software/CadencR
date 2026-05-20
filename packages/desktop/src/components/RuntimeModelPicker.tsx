import { useEffect, useMemo, useRef, useState } from "react";
import { Command, CommandEmpty, CommandInput, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  ModelGroup,
  ProviderStateGroup,
  SelectionGroup,
  getModelEntries,
  getProviderStateEntries,
  type ModelEntry,
  type ProviderStateEntry,
  type RuntimeModelPickerAction,
} from "./RuntimeModelPickerSections";

export interface RuntimeModelPickerModel {
  id: string;
  label: string;
  description?: string;
}

export interface RuntimeModelPickerProvider {
  id: string;
  label: string;
  disabled: boolean;
  status?: "available" | "unavailable" | "coming_soon";
  statusMessage?: string;
  models: RuntimeModelPickerModel[];
}

interface RuntimeModelPickerProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: React.ReactNode;
  providers: RuntimeModelPickerProvider[];
  selectedProviderId?: string;
  selectedModelId?: string;
  onSelect: (providerId: string, modelId: string) => void;
  action?: RuntimeModelPickerAction;
  searchPlaceholder?: string;
  emptyText?: string;
  align?: "start" | "center" | "end";
  contentClassName?: string;
  onAfterSelectClose?: () => void;
}

interface SelectedModelScrollParams {
  listRef: React.RefObject<HTMLDivElement | null>;
  resolvedOpen: boolean;
  search: string;
  selectedModelValue: string;
}

function useScrollSelectedModel({
  listRef,
  resolvedOpen,
  search,
  selectedModelValue,
}: SelectedModelScrollParams): void {
  useEffect(() => {
    if (!resolvedOpen || !listRef.current) return undefined;

    const frameId = requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;

      if (search.length === 0 && selectedModelValue) {
        const selectedItem = list.querySelector<HTMLElement>('[data-selected="true"]');
        if (selectedItem) {
          selectedItem.scrollIntoView({ block: "nearest" });
          return;
        }
      }

      list.scrollTop = 0;
    });

    return () => cancelAnimationFrame(frameId);
  }, [listRef, resolvedOpen, search, selectedModelValue]);
}

export function RuntimeModelPicker({
  open,
  onOpenChange,
  trigger,
  providers,
  selectedProviderId,
  selectedModelId,
  onSelect,
  action,
  searchPlaceholder = "Search providers or models...",
  emptyText = "No matching model.",
  align = "start",
  contentClassName,
  onAfterSelectClose,
}: RuntimeModelPickerProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocusAfterCloseRef = useRef(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const resolvedOpen = open ?? internalOpen;
  const selectedModelValue =
    selectedProviderId && selectedModelId ? `${selectedProviderId}:${selectedModelId}` : "";
  const selectedCommandValue = selectedModelValue || (action?.selected ? action.id : "");

  useEffect(() => {
    if (!resolvedOpen) setSearch("");
  }, [resolvedOpen]);

  useScrollSelectedModel({ listRef, resolvedOpen, search, selectedModelValue });

  const modelEntries = useMemo<ModelEntry[]>(() => getModelEntries(providers), [providers]);

  const providerStateEntries = useMemo<ProviderStateEntry[]>(
    () => getProviderStateEntries(providers),
    [providers],
  );

  function focusSearchInput(): void {
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (open === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }

  function handleActionSelect(): void {
    if (!action) return;
    restoreFocusAfterCloseRef.current = true;
    action.onSelect();
    handleOpenChange(false);
  }

  function handleModelSelect(entry: ModelEntry): void {
    restoreFocusAfterCloseRef.current = true;
    onSelect(entry.providerId, entry.modelId);
    handleOpenChange(false);
  }

  return (
    <Popover open={resolvedOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        className={cn("w-[340px] p-0", contentClassName)}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusSearchInput();
        }}
        onCloseAutoFocus={(event) => {
          if (!restoreFocusAfterCloseRef.current) return;
          restoreFocusAfterCloseRef.current = false;
          event.preventDefault();
          onAfterSelectClose?.();
        }}
      >
        <Command defaultValue={selectedCommandValue}>
          <CommandInput
            ref={inputRef}
            placeholder={searchPlaceholder}
            value={search}
            onValueChange={setSearch}
            className="h-9 text-xs"
          />
          <CommandList ref={listRef} className="max-h-[320px]">
            <CommandEmpty className="py-3 text-center text-xs">{emptyText}</CommandEmpty>
            {action ? <SelectionGroup action={action} onSelect={handleActionSelect} /> : null}
            {modelEntries.length > 0 ? (
              <ModelGroup
                entries={modelEntries}
                selectedModelValue={selectedModelValue}
                onSelect={handleModelSelect}
              />
            ) : null}
            {providerStateEntries.length > 0 ? (
              <ProviderStateGroup entries={providerStateEntries} />
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

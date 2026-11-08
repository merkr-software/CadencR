import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { useFavoriteModels } from "@/hooks/useFavoriteModels";
import { revealPickerItem } from "./RuntimeModelPickerChrome";
import { RuntimeModelPickerContent } from "./RuntimeModelPickerContent";
import type { RuntimeModelPickerAction } from "./RuntimeModelPickerSections";
import {
  catalogNeedsCollapse,
  getCatalogRefreshNotices,
  getModelEntries,
  getProviderStateEntries,
  groupCatalogEntries,
  initialExpandedGroupIds,
  type CatalogRefreshNotice,
  type ModelEntry,
  type ModelGroupSpec,
  type ProviderStateEntry,
} from "./runtimeModelPickerGroups";
import type {
  RuntimeModelPickerProvider,
  RuntimeModelSelectionResolver,
} from "./RuntimeModelPicker.types";

export type {
  RuntimeModelPickerModel,
  RuntimeModelPickerProvider,
  RuntimeModelSelectionResolver,
} from "./RuntimeModelPicker.types";

interface RuntimeModelPickerProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: React.ReactNode;
  providers: RuntimeModelPickerProvider[];
  selectedProviderId?: string;
  selectedModelId?: string;
  resolveSelectedModelId?: RuntimeModelSelectionResolver;
  onSelect: (providerId: string, modelId: string) => void;
  action?: RuntimeModelPickerAction;
  searchPlaceholder?: string;
  emptyText?: string;
  align?: "start" | "center" | "end";
  contentClassName?: string;
  onAfterSelectClose?: () => void;
}

interface SelectedModelValueParams {
  providers: RuntimeModelPickerProvider[];
  selectedProviderId?: string;
  selectedModelId?: string;
  resolveSelectedModelId?: RuntimeModelSelectionResolver;
}

function useSelectedModelValue({
  providers,
  selectedProviderId,
  selectedModelId,
  resolveSelectedModelId,
}: SelectedModelValueParams): string {
  return useMemo(() => {
    if (!selectedProviderId || !selectedModelId) return "";
    const providerModels = providers.find((provider) => provider.id === selectedProviderId)?.models;
    const modelId =
      providerModels && resolveSelectedModelId
        ? resolveSelectedModelId(selectedProviderId, selectedModelId, providerModels)
        : selectedModelId;
    return `${selectedProviderId}:${modelId}`;
  }, [providers, resolveSelectedModelId, selectedProviderId, selectedModelId]);
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
        const selectedItem = list.querySelector<HTMLElement>(
          `[data-value="${CSS.escape(selectedModelValue)}"]`,
        );
        if (selectedItem) {
          revealPickerItem(list, selectedItem);
          return;
        }
      }

      list.scrollTop = 0;
    });

    return () => cancelAnimationFrame(frameId);
  }, [listRef, resolvedOpen, search, selectedModelValue]);
}

function useModelGroups(
  providers: RuntimeModelPickerProvider[],
  listRef: RefObject<HTMLDivElement | null>,
): {
  favorites: ReadonlySet<string>;
  modelGroups: ModelGroupSpec[];
  needsCollapse: boolean;
  toggleFavorite: (value: string) => void;
  toggleHighlightedFavorite: () => void;
} {
  const { favorites, toggleFavorite } = useFavoriteModels();
  const allEntries = useMemo<ModelEntry[]>(() => getModelEntries(providers), [providers]);
  const modelGroups = useMemo<ModelGroupSpec[]>(
    () => groupCatalogEntries(allEntries, favorites),
    [allEntries, favorites],
  );
  const needsCollapse = catalogNeedsCollapse(modelGroups);
  const modelValues = useMemo(() => new Set(allEntries.map((entry) => entry.value)), [allEntries]);

  const toggleHighlightedFavorite = useCallback(() => {
    const highlighted = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    const value = highlighted?.dataset.value;
    if (!value || !modelValues.has(value)) return;
    toggleFavorite(value);
  }, [listRef, modelValues, toggleFavorite]);

  return useMemo(
    () => ({ favorites, modelGroups, needsCollapse, toggleFavorite, toggleHighlightedFavorite }),
    [favorites, modelGroups, needsCollapse, toggleFavorite, toggleHighlightedFavorite],
  );
}

function useExpandedGroups(
  resolvedOpen: boolean,
  modelGroups: ModelGroupSpec[],
  selectedModelValue: string,
): {
  expandedGroupIds: ReadonlySet<string>;
  expandGroup: (groupId: string) => void;
  collapseGroup: (groupId: string) => void;
} {
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const userTouchedRef = useRef(false);

  useEffect(() => {
    if (!resolvedOpen) {
      userTouchedRef.current = false;
      setExpandedGroupIds((current) => (current.size === 0 ? current : new Set()));
      return;
    }
    if (userTouchedRef.current) return;
    const ids = initialExpandedGroupIds(modelGroups, selectedModelValue);
    setExpandedGroupIds((current) => {
      if (current.size === ids.length && ids.every((id) => current.has(id))) return current;
      return new Set(ids);
    });
  }, [modelGroups, resolvedOpen, selectedModelValue]);

  const expandGroup = useCallback((groupId: string) => {
    userTouchedRef.current = true;
    setExpandedGroupIds((current) => new Set(current).add(groupId));
  }, []);

  const collapseGroup = useCallback((groupId: string) => {
    userTouchedRef.current = true;
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });
  }, []);

  return { expandedGroupIds, expandGroup, collapseGroup };
}

function usePickerSelection(params: {
  action?: RuntimeModelPickerAction;
  controlledOpen: boolean | undefined;
  onOpenChange?: (open: boolean) => void;
  onSelect: (providerId: string, modelId: string) => void;
  setInternalOpen: (open: boolean) => void;
  restoreFocusAfterCloseRef: RefObject<boolean>;
}): {
  handleActionSelect: () => void;
  handleModelSelect: (entry: ModelEntry) => void;
  handleOpenChange: (nextOpen: boolean) => void;
} {
  const {
    action,
    controlledOpen,
    onOpenChange,
    onSelect,
    restoreFocusAfterCloseRef,
    setInternalOpen,
  } = params;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange, setInternalOpen],
  );

  const handleActionSelect = useCallback(() => {
    if (!action) return;
    restoreFocusAfterCloseRef.current = true;
    action.onSelect();
    handleOpenChange(false);
  }, [action, handleOpenChange, restoreFocusAfterCloseRef]);

  const handleModelSelect = useCallback(
    (entry: ModelEntry) => {
      restoreFocusAfterCloseRef.current = true;
      onSelect(entry.providerId, entry.modelId);
      handleOpenChange(false);
    },
    [handleOpenChange, onSelect, restoreFocusAfterCloseRef],
  );

  return { handleActionSelect, handleModelSelect, handleOpenChange };
}

export function RuntimeModelPicker({
  open,
  onOpenChange,
  trigger,
  providers,
  selectedProviderId,
  selectedModelId,
  resolveSelectedModelId,
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
  const selectedModelValue = useSelectedModelValue({
    providers,
    selectedProviderId,
    selectedModelId,
    resolveSelectedModelId,
  });
  const selectedCommandValue = selectedModelValue || (action?.selected ? action.id : "");

  useEffect(() => {
    if (!resolvedOpen) setSearch("");
  }, [resolvedOpen]);

  useScrollSelectedModel({ listRef, resolvedOpen, search, selectedModelValue });

  const { favorites, modelGroups, needsCollapse, toggleFavorite, toggleHighlightedFavorite } =
    useModelGroups(providers, listRef);
  const { expandedGroupIds, expandGroup, collapseGroup } = useExpandedGroups(
    resolvedOpen,
    modelGroups,
    selectedModelValue,
  );
  const { handleActionSelect, handleModelSelect, handleOpenChange } = usePickerSelection({
    action,
    controlledOpen: open,
    onOpenChange,
    onSelect,
    restoreFocusAfterCloseRef,
    setInternalOpen,
  });

  const providerStateEntries = useMemo<ProviderStateEntry[]>(
    () => getProviderStateEntries(providers),
    [providers],
  );
  const catalogNotices = useMemo<CatalogRefreshNotice[]>(
    () => getCatalogRefreshNotices(providers),
    [providers],
  );

  return (
    <Popover open={resolvedOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <RuntimeModelPickerContent
        action={action}
        align={align}
        catalogNotices={catalogNotices}
        contentClassName={contentClassName}
        emptyText={emptyText}
        expandedGroupIds={expandedGroupIds}
        favorites={favorites}
        inputRef={inputRef}
        isSearching={search.trim().length > 0}
        listRef={listRef}
        modelGroups={modelGroups}
        needsCollapse={needsCollapse}
        onActionSelect={handleActionSelect}
        onAfterSelectClose={onAfterSelectClose}
        onCollapseGroup={collapseGroup}
        onExpandGroup={expandGroup}
        onModelSelect={handleModelSelect}
        onToggleFavorite={toggleFavorite}
        onToggleHighlightedFavorite={toggleHighlightedFavorite}
        providerStateEntries={providerStateEntries}
        restoreFocusAfterCloseRef={restoreFocusAfterCloseRef}
        search={search}
        searchPlaceholder={searchPlaceholder}
        selectedCommandValue={selectedCommandValue}
        selectedModelValue={selectedModelValue}
        setSearch={setSearch}
      />
    </Popover>
  );
}

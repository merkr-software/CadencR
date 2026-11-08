import { favoriteModelKey } from "@/lib/favorite-models";
import type {
  RuntimeModelPickerModel,
  RuntimeModelPickerProvider,
} from "./RuntimeModelPicker.types";

export interface ModelEntry {
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  description?: string;
  value: string;
  keywords: string[];
}

/** A provider whose picker models are its last known catalog. */
export interface CatalogRefreshNotice {
  providerId: string;
  providerLabel: string;
  reason: string;
}

export interface ProviderStateEntry {
  providerId: string;
  providerLabel: string;
  statusLabel: string;
  value: string;
  keywords: string[];
}

export interface VendorSection {
  id: string;
  vendorKey?: string;
  heading?: string;
  entries: ModelEntry[];
}

export interface ModelGroupSpec {
  id: string;
  heading: string;
  providerId: string;
  kind: "starred" | "provider";
  entries: ModelEntry[];
  vendors: VendorSection[];
  collapsible: boolean;
}

/** Idle catalogs longer than this collapse inactive groups to a single browse row. */
export const IDLE_COLLAPSE_AFTER = 12;

const BROWSE_VALUE_PREFIX = "__browse__:";

export function browseGroupValue(groupId: string): string {
  return `${BROWSE_VALUE_PREFIX}${groupId}`;
}

export function vendorPrefix(modelId: string): string | undefined {
  const index = modelId.indexOf("/");
  if (index <= 0) return undefined;
  return modelId.slice(0, index);
}

/**
 * cmdk's default scorer is letter-subsequence fuzzy matching, so "Sol" hits
 * "Fable" via a long description. Require a contiguous substring of the value
 * or keywords instead (name, id, provider, description).
 */
export function modelPickerFilter(value: string, search: string, keywords: string[] = []): number {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return 1;
  if (value.toLowerCase().includes(needle)) return 1;
  return keywords.some((field) => field.toLowerCase().includes(needle)) ? 1 : 0;
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
      value: favoriteModelKey(provider.id, model.id),
      keywords: [provider.label, provider.id, model.label, model.id, model.description ?? ""],
    }));
  });
}

/**
 * Splits the catalog into starred and unstarred entries, preserving catalog
 * order within each half. An entry appears in exactly one group: duplicating a
 * cmdk `value` would break selection and highlighting.
 */
function partitionModelEntries(
  entries: ModelEntry[],
  favorites: ReadonlySet<string>,
): { favorite: ModelEntry[]; rest: ModelEntry[] } {
  const favorite: ModelEntry[] = [];
  const rest: ModelEntry[] = [];
  for (const entry of entries) {
    (favorites.has(entry.value) ? favorite : rest).push(entry);
  }
  return { favorite, rest };
}

export function groupCatalogEntries(
  entries: ModelEntry[],
  favorites: ReadonlySet<string>,
): ModelGroupSpec[] {
  const { favorite, rest } = partitionModelEntries(entries, favorites);
  const groups: ModelGroupSpec[] = [];
  if (favorite.length > 0) {
    groups.push({
      id: "starred",
      heading: "Starred",
      providerId: "",
      kind: "starred",
      entries: favorite,
      vendors: [{ id: "starred", entries: favorite }],
      collapsible: false,
    });
  }
  groups.push(...groupByProvider(rest));
  return groups.filter((group) => group.entries.length > 0);
}

export function catalogNeedsCollapse(groups: readonly ModelGroupSpec[]): boolean {
  let count = 0;
  for (const group of groups) {
    if (!group.collapsible) continue;
    count += group.entries.length;
    if (count > IDLE_COLLAPSE_AFTER) return true;
  }
  return false;
}

export function isProviderCollapsed(
  group: ModelGroupSpec,
  expandedGroupIds: ReadonlySet<string>,
  needsCollapse: boolean,
  isSearching: boolean,
): boolean {
  if (!group.collapsible || !needsCollapse || isSearching) return false;
  return !expandedGroupIds.has(group.id);
}

export function isVendorCollapsed(
  group: ModelGroupSpec,
  vendor: VendorSection,
  expandedGroupIds: ReadonlySet<string>,
  needsCollapse: boolean,
  isSearching: boolean,
): boolean {
  if (!needsCollapse || isSearching) return false;
  if (group.vendors.length <= 1) return false;
  if (vendor.entries.length <= IDLE_COLLAPSE_AFTER) return false;
  return !expandedGroupIds.has(vendor.id);
}

export function initialExpandedGroupIds(
  groups: readonly ModelGroupSpec[],
  selectedValue: string,
): string[] {
  const catalogGroup = catalogGroupForSelection(groups, selectedValue);
  if (!catalogGroup) return [];

  const ids = [catalogGroup.id];
  const vendor = vendorSectionForSelection(catalogGroup, groups, selectedValue);
  if (vendor && catalogGroup.vendors.length > 1 && vendor.entries.length > IDLE_COLLAPSE_AFTER) {
    ids.push(vendor.id);
  }
  return ids;
}

export function displayModelLabel(entry: ModelEntry, vendorKey?: string): string {
  if (vendorKey && entry.modelLabel === entry.modelId) {
    const prefix = `${vendorKey}/`;
    if (entry.modelId.startsWith(prefix)) return entry.modelId.slice(prefix.length);
  }
  return entry.modelLabel;
}

export function displayModelId(entry: ModelEntry, visibleLabel: string): string | undefined {
  if (entry.modelId.toLowerCase() === visibleLabel.toLowerCase()) return undefined;
  // A distinct catalog label is the name. Don't restack the raw id under it
  // ("Codex 5.3 Fast" over `gpt-5.3-codex-fast`). Keep the id only when the
  // visible text is a shortened form of the id itself (vendor prefix stripped).
  if (entry.modelLabel.toLowerCase() !== entry.modelId.toLowerCase()) return undefined;
  return entry.modelId;
}

export function displayModelDescription(
  entry: ModelEntry,
  visibleLabel: string,
  visibleId?: string,
): string | undefined {
  const description = entry.description?.trim();
  if (!description) return undefined;
  const lower = description.toLowerCase();
  if (lower === visibleLabel.toLowerCase()) return undefined;
  if (visibleId && lower === visibleId.toLowerCase()) return undefined;
  return description;
}

/** Picker entry for an available catalog provider, keeping its model type. */
export function pickerProviderFromCatalog<Model extends RuntimeModelPickerModel>(provider: {
  id: string;
  label: string;
  models: Model[];
  refresh_error?: string;
}): Omit<RuntimeModelPickerProvider, "models"> & { models: Model[] } {
  return {
    id: provider.id,
    label: provider.label,
    disabled: false,
    refreshError: provider.refresh_error,
    models: provider.models,
  };
}

export function getCatalogRefreshNotices(
  providers: RuntimeModelPickerProvider[],
): CatalogRefreshNotice[] {
  return providers.flatMap((provider) =>
    !provider.disabled && provider.models.length > 0 && provider.refreshError
      ? [{ providerId: provider.id, providerLabel: provider.label, reason: provider.refreshError }]
      : [],
  );
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

function catalogGroupForSelection(
  groups: readonly ModelGroupSpec[],
  selectedValue: string,
): ModelGroupSpec | undefined {
  const containing = groups.find((group) =>
    group.entries.some((entry) => entry.value === selectedValue),
  );
  if (containing?.collapsible) return containing;

  const selected = containing?.entries.find((entry) => entry.value === selectedValue);
  if (!selected) return groups.find((group) => group.collapsible);

  return groups.find((group) => group.collapsible && group.providerId === selected.providerId);
}

function vendorSectionForSelection(
  catalogGroup: ModelGroupSpec,
  groups: readonly ModelGroupSpec[],
  selectedValue: string,
): VendorSection | undefined {
  const inCatalog = catalogGroup.vendors.find((vendor) =>
    vendor.entries.some((entry) => entry.value === selectedValue),
  );
  if (inCatalog) return inCatalog;

  const selected = groups
    .flatMap((group) => group.entries)
    .find((entry) => entry.value === selectedValue);
  if (!selected) return catalogGroup.vendors[0];

  const vendorKey = vendorPrefix(selected.modelId);
  return (
    catalogGroup.vendors.find((vendor) => vendor.vendorKey === vendorKey) ?? catalogGroup.vendors[0]
  );
}

function groupByProvider(entries: ModelEntry[]): ModelGroupSpec[] {
  const buckets = new Map<string, ModelEntry[]>();
  const labels = new Map<string, string>();
  const order: string[] = [];

  for (const entry of entries) {
    let bucket = buckets.get(entry.providerId);
    if (!bucket) {
      bucket = [];
      buckets.set(entry.providerId, bucket);
      labels.set(entry.providerId, entry.providerLabel);
      order.push(entry.providerId);
    }
    bucket.push(entry);
  }

  return order.map((providerId) => {
    const providerEntries = buckets.get(providerId) ?? [];
    return {
      id: providerId,
      heading: labels.get(providerId) ?? providerId,
      providerId,
      kind: "provider" as const,
      entries: providerEntries,
      vendors: splitVendors(providerId, providerEntries),
      collapsible: true,
    };
  });
}

function splitVendors(providerId: string, entries: ModelEntry[]): VendorSection[] {
  const buckets = new Map<string, ModelEntry[]>();
  const order: string[] = [];

  for (const entry of entries) {
    const vendorKey = vendorPrefix(entry.modelId);
    const id = vendorKey ? `${providerId}::${vendorKey}` : providerId;
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = [];
      buckets.set(id, bucket);
      order.push(id);
    }
    bucket.push(entry);
  }

  const showHeadings = order.length > 1;
  return order.map((id) => {
    const vendorEntries = buckets.get(id) ?? [];
    const vendorKey = vendorPrefix(vendorEntries[0]?.modelId ?? "");
    return {
      id,
      vendorKey,
      heading: showHeadings ? vendorKey : undefined,
      entries: vendorEntries,
    };
  });
}

function getProviderStatusLabel(provider: RuntimeModelPickerProvider): string {
  if (!provider.disabled) return "No models available";
  if (provider.status === "unavailable") return provider.statusMessage ?? "Unavailable";
  return "Coming soon";
}

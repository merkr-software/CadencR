import type { SegmentedOption } from "@/components/usage/UsageSegmentedControl";
import type { SidebarConfig, SidebarOptionId } from "@/lib/sidebar-config";

export type ChoiceId = {
  [K in SidebarOptionId]: SidebarConfig[K] extends string ? K : never;
}[SidebarOptionId];
export type ToggleId = {
  [K in SidebarOptionId]: SidebarConfig[K] extends boolean ? K : never;
}[SidebarOptionId];

export interface ChoiceRow<K extends ChoiceId> {
  id: K;
  label: string;
  /** Shown on the Settings page, where there is room to explain. */
  description: string;
  options: readonly SegmentedOption<SidebarConfig[K]>[];
  /** A dropdown instead of segments, for choices too many to sit side by side. */
  control?: "select";
}

export type SidebarChoice = { [K in ChoiceId]: ChoiceRow<K> }[ChoiceId];
export interface SidebarToggle {
  id: ToggleId;
  label: string;
  description: string;
}

/** Keep option IDs stable and read their copy in the current language when rendered. */
export function displayOption<T extends string>(
  value: T,
  label: () => string,
  title?: () => string,
): SegmentedOption<T> {
  return {
    value,
    get label() {
      return label();
    },
    get title() {
      return title?.();
    },
  };
}

export function displayChoice<K extends ChoiceId>(
  id: K,
  label: () => string,
  description: () => string,
  options: ChoiceRow<K>["options"],
  control?: "select",
): ChoiceRow<K> {
  return {
    id,
    get label() {
      return label();
    },
    get description() {
      return description();
    },
    options,
    control,
  };
}

export function displayToggle(
  id: ToggleId,
  label: () => string,
  description: () => string,
): SidebarToggle {
  return {
    id,
    get label() {
      return label();
    },
    get description() {
      return description();
    },
  };
}

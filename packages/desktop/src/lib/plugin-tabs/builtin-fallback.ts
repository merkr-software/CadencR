import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { activateFeatureTab } from "@/stores/feature-layout-store";
import type { TabKind } from "@/stores/feature-layout-schema";

import { isReplaceableTab, REPLACEABLE_TABS, type ReplaceableTab } from "./tab-replacements";

/** Built-in tab → id of the custom tab in its place. */
export type ReplacedTabs = Readonly<Partial<Record<ReplaceableTab, string>>>;

/**
 * Built-in tab → id of the custom tab set aside for it, or `null` when it was
 * brought back before its page knew which tab replaces it.
 */
export type BuiltinFallbacks = Readonly<Partial<Record<ReplaceableTab, string | null>>>;

interface BuiltinFallbackState {
  /**
   * Layout scope id → the custom tabs shown in place of built-ins on that
   * page, once it has read the setting and the project's tabs. No entry while
   * it is unmounted or still loading.
   */
  replaced: Readonly<Record<number, ReplacedTabs>>;
  /** Layout scope id → built-in tabs shown instead of their custom replacement. */
  shown: Readonly<Record<number, BuiltinFallbacks>>;
}

/**
 * Where Cadencr brought a replaced built-in tab back (docs/CUSTOM_TABS.md
 * §10): a file, a pull request, a document or a command only the built-in
 * can show. The built-in then keeps its place until the user switches back
 * from the "+" menu, or another tab is chosen for it. In memory only: a
 * restart shows the replacements again.
 */
export const useBuiltinTabFallbacks = create<BuiltinFallbackState>(() => ({
  replaced: {},
  shown: {},
}));

const NO_FALLBACKS: BuiltinFallbacks = Object.freeze({});

function sameRecord<T>(a: Readonly<Partial<Record<ReplaceableTab, T>>>, b: typeof a): boolean {
  return REPLACEABLE_TABS.every((tab) => a[tab] === b[tab]);
}

/** Whether `fallbacks` sets aside the custom tab `id` (or whatever replaces the built-in). */
export function isSetAside(fallbacks: BuiltinFallbacks, tab: ReplaceableTab, id: string): boolean {
  const setAside = fallbacks[tab];
  return setAside === null || setAside === id;
}

/**
 * Record what a conversation's page resolved: the custom tabs shown in place
 * of built-ins (`replaced`, those able to run), and the ones chosen there
 * (`chosen`, listed and declaring the built-in, running or not). A built-in
 * brought back stays while the tab it set aside is still the one chosen, so
 * a tab briefly unable to run (rebuilding, switched off and on) doesn't take
 * its place back, and a tab chosen later isn't hidden.
 */
export function setReplacedTabs(
  featureId: number,
  replaced: ReplacedTabs,
  chosen: ReplacedTabs,
): void {
  const state = useBuiltinTabFallbacks.getState();
  const shown = state.shown[featureId] ?? NO_FALLBACKS;
  const kept: Partial<Record<ReplaceableTab, string>> = {};
  for (const tab of REPLACEABLE_TABS) {
    const id = chosen[tab];
    if (id && tab in shown && isSetAside(shown, tab, id)) kept[tab] = id;
  }
  const current = state.replaced[featureId];
  if (current && sameRecord(current, replaced) && sameRecord(shown, kept)) return;
  useBuiltinTabFallbacks.setState({
    replaced: { ...state.replaced, [featureId]: replaced },
    shown: sameRecord(shown, kept) ? state.shown : { ...state.shown, [featureId]: kept },
  });
}

/**
 * The page stopped resolving its replacements (unmounted): until it does
 * again, a built-in brought back there is kept whatever replaces it.
 */
export function forgetReplacedTabs(featureId: number): void {
  const { replaced } = useBuiltinTabFallbacks.getState();
  if (!(featureId in replaced)) return;
  const { [featureId]: _forgotten, ...rest } = replaced;
  useBuiltinTabFallbacks.setState({ replaced: rest });
}

/** The built-in tabs shown in place of their replacement in this layout. */
export function builtinFallbacks(featureId: number): BuiltinFallbacks {
  return useBuiltinTabFallbacks.getState().shown[featureId] ?? NO_FALLBACKS;
}

export function useBuiltinFallbacks(featureId: number): BuiltinFallbacks {
  return useBuiltinTabFallbacks((state) => state.shown[featureId] ?? NO_FALLBACKS);
}

function replacementShown(state: BuiltinFallbackState, featureId: number, tab: TabKind): boolean {
  if (!isReplaceableTab(tab)) return false;
  const id = state.replaced[featureId]?.[tab];
  return id !== undefined && !isSetAside(state.shown[featureId] ?? NO_FALLBACKS, tab, id);
}

/**
 * Whether a custom tab holds `tab`'s place in this layout now, so what the
 * built-in would do there (its shortcuts, its ⌘W) does not apply.
 */
export function isReplacementShown(featureId: number, tab: TabKind): boolean {
  return replacementShown(useBuiltinTabFallbacks.getState(), featureId, tab);
}

/** The built-in places showing a custom tab in this layout now. */
export function useReplacementShownTabs(featureId: number): readonly ReplaceableTab[] {
  return useBuiltinTabFallbacks(
    useShallow((state) =>
      REPLACEABLE_TABS.filter((tab) => replacementShown(state, featureId, tab)),
    ),
  );
}

function setShown(
  featureId: number,
  tab: ReplaceableTab,
  setAside: string | null | undefined,
): void {
  const current = builtinFallbacks(featureId);
  if (current[tab] === setAside) return;
  const { [tab]: _previous, ...rest } = current;
  const next = setAside === undefined ? rest : { ...rest, [tab]: setAside };
  useBuiltinTabFallbacks.setState((state) => ({ shown: { ...state.shown, [featureId]: next } }));
}

/**
 * Show the built-in `tab` rather than the custom tab replacing it, in this
 * layout. A no-op where its page resolved that nothing replaces it; kept
 * while the page is not there yet, since it may still turn out replaced.
 */
export function showBuiltinTab(featureId: number, tab: TabKind): void {
  if (!isReplaceableTab(tab)) return;
  const replaced = useBuiltinTabFallbacks.getState().replaced[featureId];
  if (!replaced) {
    if (!(tab in builtinFallbacks(featureId))) setShown(featureId, tab, null);
    return;
  }
  const id = replaced[tab];
  if (id) setShown(featureId, tab, id);
}

/** Show the custom tab chosen to replace `tab` again. */
export function showReplacementTab(featureId: number, tab: ReplaceableTab): void {
  setShown(featureId, tab, undefined);
}

/**
 * `activateFeatureTab` for an action that needs the built-in tab itself (it
 * opened a file, a pull request, a document or a command in it).
 */
export function activateBuiltinFeatureTab(featureId: number, tab: TabKind): boolean {
  showBuiltinTab(featureId, tab);
  return activateFeatureTab(featureId, tab);
}

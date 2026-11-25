import { translateUi } from "@/lib/i18n/ui";
import { toast } from "sonner";

import type { FeatureLayout, FeatureSetting } from "@/api/generated";
import {
  LAYOUT_STATE_KEY,
  flatLayoutState,
  parseLayoutState,
  type FeatureLayoutState,
} from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";

/**
 * The layout a feature starts on, the first time it is seen in the session:
 *  1. Feature-specific `layout_state`.
 *  2. Workspace default layout (the saved layout flagged `is_default`).
 *  3. Flat fallback (every tab in the root pane, agent active).
 */
function resolveInitialLayout(
  settings: readonly FeatureSetting[],
  layouts: readonly FeatureLayout[],
): FeatureLayoutState {
  const savedCurrent = settings.find((setting) => setting.key === LAYOUT_STATE_KEY);
  if (savedCurrent) {
    const parsed = parseLayoutState(savedCurrent.value);
    if (parsed) return parsed;
    toast.error(
      translateUi(
        "workspace.tools.featureLayoutHydration.savedFeatureLayoutIsMalformedAndWas",
        "Saved feature layout is malformed and was skipped.",
      ),
    );
  }
  const defaultLayout = layouts.find((layout) => layout.is_default);
  if (defaultLayout) {
    const parsed = parseLayoutState(defaultLayout.config);
    if (parsed) return { ...parsed, appliedLayoutId: defaultLayout.id };
    toast.error(
      translateUi(
        "workspace.tools.featureLayoutHydration.defaultMalformed",
        'Default layout "{{name}}" is malformed and was skipped.',
        { name: defaultLayout.name },
      ),
    );
  }
  return flatLayoutState();
}

/**
 * One-shot hydrate of the in-memory layout store for a feature. A feature that
 * already has state in the store (visited this session) keeps it: the in-memory
 * state is the source of truth.
 */
export function hydrateFeatureLayout(
  featureId: number,
  settings: readonly FeatureSetting[],
  layouts: readonly FeatureLayout[],
): void {
  const store = useFeatureLayoutStore.getState();
  if (store.features[featureId]) return;
  store.setState(featureId, resolveInitialLayout(settings, layouts));
}

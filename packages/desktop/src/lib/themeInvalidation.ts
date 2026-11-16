import type { QueryClient } from "@tanstack/react-query";
import { getListProjectsQueryKey, getListThemesQueryKey } from "@/api/generated";
import { createLeadingSettleCoalescer } from "./coalesceInvalidation";
import { managedThemesKey } from "./theme-marketplace";

/**
 * Refetch the user's themes.
 *
 * The window is short because this drives a live preview: the leading edge
 * fires immediately so a save repaints at once, and the trailing edge catches
 * the final content of a burst. Each refetch costs a full server-side re-read
 * and re-validation of every theme file, so an editor that saves on every
 * keystroke must not translate into one of those per keystroke.
 */
const THEME_INVALIDATION_SETTLE_MS = 150;

/**
 * The themes, and the project list that carries their names.
 *
 * A theme's label is the name of its project in the sidebar, and the backend
 * renames the project from the same write that repaints the app — so a rename
 * made in the file (by the user's editor, or by the agent) reaches the sidebar
 * only if the list is refetched too. Both keys are exact: nothing else under
 * `/api/projects/…` — a project's settings, its model config — is affected by
 * a theme file, and sweeping the prefix would refetch all of it on every save.
 */
function invalidateThemes(client: QueryClient): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: getListThemesQueryKey() }),
    client.invalidateQueries({ queryKey: getListProjectsQueryKey() }),
  ]).then(() => undefined);
}

const themeCoalescer = createLeadingSettleCoalescer<QueryClient>(
  invalidateThemes,
  THEME_INVALIDATION_SETTLE_MS,
);

export function scheduleThemeInvalidation(client: QueryClient, id?: string): void {
  if (id?.startsWith("managed:")) {
    void client.invalidateQueries({ queryKey: managedThemesKey });
    return;
  }
  themeCoalescer.trigger(client);
}

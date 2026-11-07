import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  getGetFeatureSettingsQueryKey,
  useSetFeatureSetting,
  useThemeWorkspace,
  type UserTheme,
  type ThemeWorkspace,
} from "@/api/generated";
import { useSystemAppearance } from "@/hooks/useSystemAppearance";
import { useTheme } from "@/hooks/useTheme";
import { apiErrorMessage } from "@/lib/api-errors";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { userThemeId, userThemeLabel } from "@/lib/themes/user-theme";
import { useEditorFileNavigator } from "@/hooks/useOpenEditorFile";
import { LAYOUT_STATE_KEY, serializeCurrentLayoutState } from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { THEME_FILE_NAME, themeLayoutState } from "./theme-workspace";

/**
 * Open a theme for editing — which means going to its project.
 *
 * A theme isn't edited in a dialog: it has a project of its own, so the file
 * sits in the editor, an agent works beside it and git records what changed,
 * exactly as for any other code. Creation returns the ready workspace; later
 * opens resolve those same ids through the idempotent workspace endpoint.
 *
 * Opening also *wears* the theme. The whole reason a theme has a project rather
 * than a modal is that the user keeps using the app while it is being restyled,
 * and that only means anything if the app is wearing the theme being edited —
 * every save, whether the user's or the agent's, then repaints the window they
 * are already looking at.
 */
export interface OpenThemeProject {
  open: (theme: UserTheme, createdWorkspace?: ThemeWorkspace) => void;
  /** The theme whose project is being resolved, so only its own control waits. */
  openingId: string | null;
}

export function useOpenThemeProject(): OpenThemeProject {
  const navigate = useNavigate();
  const openFile = useEditorFileNavigator();
  const queryClient = useQueryClient();
  const workspace = useThemeWorkspace();
  const wear = useWearTheme();
  const arrangePanes = useArrangePanes();
  const [openingId, setOpeningId] = useState<string | null>(null);
  const mutateAsync = workspace.mutateAsync;

  const open = useCallback(
    (theme: UserTheme, createdWorkspace?: ThemeWorkspace): void => {
      setOpeningId(theme.id);
      const opening = createdWorkspace
        ? Promise.resolve(createdWorkspace)
        : mutateAsync({ id: theme.id });
      opening
        .then(async (opened) => {
          wear(theme);
          if (opened.created) await arrangePanes(opened.feature_id);
          // Every open, not only the first: editor tabs live for the session,
          // and "edit this theme" has to put the theme in front of the user.
          openFile(opened.feature_id, { path: THEME_FILE_NAME });
          // The project may have just been created; the sidebar is showing a
          // list that predates it.
          await invalidateByUrlPrefix(queryClient, ["/api/projects", "/api/features"]);
          await navigate({
            to: "/projects/$projectId/features/$featureId",
            params: {
              projectId: String(opened.project_id),
              featureId: String(opened.feature_id),
            },
          });
        })
        .catch((error: unknown) => {
          toast.error(apiErrorMessage(error, "Failed to open the theme"));
        })
        .finally(() => setOpeningId(null));
    },
    [arrangePanes, mutateAsync, navigate, openFile, queryClient, wear],
  );

  return useMemo(() => ({ open, openingId }), [open, openingId]);
}

/**
 * Put the theme file beside the agent, once.
 *
 * Written to the feature's settings rather than only into the store, because
 * layout persistence treats whatever it first observes as the saved baseline
 * and never writes it back — a store-only arrangement would be gone by the
 * next launch. Seeded into the store as well so this session doesn't wait for
 * a refetch to see it.
 */
function useArrangePanes(): (featureId: number) => Promise<void> {
  const queryClient = useQueryClient();
  const { mutateAsync } = useSetFeatureSetting();

  return useCallback(
    async (featureId: number): Promise<void> => {
      const layout = themeLayoutState();
      useFeatureLayoutStore.getState().setState(featureId, layout);
      try {
        await mutateAsync({
          id: featureId,
          data: { key: LAYOUT_STATE_KEY, value: serializeCurrentLayoutState(layout) },
        });
        // The cached settings for this feature predate the layout; hydration
        // reads them, and a stale copy would arrange the panes back.
        void queryClient.invalidateQueries({ queryKey: getGetFeatureSettingsQueryKey(featureId) });
      } catch (error: unknown) {
        // Not fatal — the arrangement is applied for this session either way,
        // it just won't come back on the next launch.
        toast.error(apiErrorMessage(error, "Could not save the theme's pane layout"));
      }
    },
    [mutateAsync],
  );
}

/**
 * Put a theme on.
 *
 * With "follow system" on there is no single active theme to set, so the theme
 * goes into the slot for its own appearance — the same model the theme drawer
 * uses. That can leave it not showing yet (a dark theme while the system is
 * light), which is worth saying out loud: the user is about to edit a theme and
 * watch for changes that wouldn't come.
 */
function useWearTheme(): (theme: UserTheme) => void {
  const { followSystemTheme, setTheme, setSystemLightTheme, setSystemDarkTheme } = useTheme();
  const system = useSystemAppearance();

  return useCallback(
    (theme: UserTheme): void => {
      // A theme that failed validation has no appearance and can't be applied;
      // the card's issue banner already explains why.
      const appearance = theme.theme?.appearance;
      if (!appearance) return;
      const id = userThemeId(theme.id);
      if (!followSystemTheme) {
        setTheme(id);
        return;
      }
      if (appearance === "light") setSystemLightTheme(id);
      else setSystemDarkTheme(id);
      if (system.appearance !== appearance) {
        toast.info(
          `“${userThemeLabel(theme)}” is now your ${appearance} theme. Your system is in ${system.appearance} mode, so you'll see it there.`,
        );
      }
    },
    [followSystemTheme, setSystemDarkTheme, setSystemLightTheme, setTheme, system.appearance],
  );
}

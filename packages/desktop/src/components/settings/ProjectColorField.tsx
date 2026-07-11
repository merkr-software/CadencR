import { useCallback } from "react";
import { ProjectColorPicker } from "@/components/settings/ProjectColorPicker";
import { useSyncedSettingInput } from "@/hooks/useSyncedSettingInput";

/** Project setting key owned by this field. */
export const PROJECT_COLOR_SETTING_KEY = "color" as const;

/**
 * Project accent-color picker with the shared dirty-tracked autosave. Shared by
 * the Project Settings dialog (Identity section) and the new-project onboarding
 * modal so the two stay in lockstep. Callers own the surrounding card/section
 * chrome and the actual persistence via `onSave`.
 */
export function ProjectColorField({
  resetKeyPrefix,
  color,
  onSave,
}: {
  /** Scopes the local-input reset key (e.g. the project id) so switching
   *  projects re-seeds from the new remote value. */
  resetKeyPrefix: string;
  color: string | undefined;
  onSave: (key: typeof PROJECT_COLOR_SETTING_KEY, value: string) => void;
}): React.JSX.Element {
  const colorInput = useSyncedSettingInput(color, `${resetKeyPrefix}:color`);

  const commitColor = useCallback(
    (next: string): void => {
      colorInput.setValue(next);
      if (next !== (color ?? "")) onSave(PROJECT_COLOR_SETTING_KEY, next);
    },
    [colorInput, color, onSave],
  );

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Project color</div>
      <p className="text-xs text-muted-foreground">
        Accent dot used for this project in the sidebar.
      </p>
      <ProjectColorPicker value={colorInput.value} onChange={commitColor} />
    </div>
  );
}

import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useMemo } from "react";
import { useFileTreeIconSet, type FileTreeIconSet } from "@/hooks/useFileTreeIconSet";
import { RadioCardGroup, type RadioCardOption } from "./RadioCardGroup";

interface IconSetEntry {
  value: FileTreeIconSet;
  label: string;
  description: string;
}

function iconSets(t: UiTranslator): readonly IconSetEntry[] {
  return [
    {
      value: "minimal",
      label: t("workspace.editor.fileTreeIconSetSelector.minimal", "Minimal"),
      description: t(
        "workspace.editor.fileTreeIconSetSelector.minimalDescription",
        "Single generic file and folder icon with minimal visual noise.",
      ),
    },
    {
      value: "standard",
      label: t("workspace.editor.fileTreeIconSetSelector.standard", "Standard"),
      description: t(
        "workspace.editor.fileTreeIconSetSelector.standardDescription",
        "File-type icons for popular languages and config files.",
      ),
    },
    {
      value: "complete",
      label: t("workspace.editor.fileTreeIconSetSelector.complete", "Complete"),
      description: t(
        "workspace.editor.fileTreeIconSetSelector.completeDescription",
        "Full VS Code-style icon set, every common extension covered.",
      ),
    },
  ];
}

/**
 * Picker for the file-tree icon set used by the editor's @pierre/trees
 * renderer. Persisted at workspace scope (see `useFileTreeIconSet`); changes
 * apply immediately to every open tree without a remount.
 */
export function FileTreeIconSetSelector(): React.JSX.Element {
  const { t } = useUiTranslation();
  const { iconSet, setIconSet, isLoading } = useFileTreeIconSet();

  const options = useMemo<RadioCardOption<FileTreeIconSet>[]>(
    () =>
      iconSets(t).map((entry) => ({
        value: entry.value,
        label: entry.label,
        description: entry.description,
      })),
    [t],
  );

  return (
    <RadioCardGroup<FileTreeIconSet>
      ariaLabel={t("workspace.editor.fileTreeIconSetSelector.ariaLabel", "File tree icon set")}
      value={iconSet}
      onChange={setIconSet}
      options={options}
      layout="stack"
      showDot
      disabled={isLoading}
    />
  );
}

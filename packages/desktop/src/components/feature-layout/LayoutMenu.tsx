import { useUiTranslation } from "@/lib/i18n/ui";
import { useState, type ReactNode } from "react";
import { CheckIcon, LayoutTemplateIcon, StarIcon, Undo2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useSavedLayouts } from "@/hooks/useSavedLayouts";
import { noteUserLayoutChange, undoAutoLayout } from "@/lib/auto-layout/auto-layout-controller";
import { useAutoLayoutStore } from "@/stores/auto-layout-store";
import { selectFeatureLayout, useFeatureLayoutStore } from "@/stores/feature-layout-store";
import type { FeatureLayout } from "@/api/generated";

interface LayoutMenuProps {
  featureId: number;
}

function SavedLayoutItems({
  layouts,
  appliedLayoutId,
  onApply,
}: {
  layouts: FeatureLayout[];
  appliedLayoutId: number | null;
  onApply: (layout: FeatureLayout) => void;
}): ReactNode {
  const { t } = useUiTranslation();
  if (layouts.length === 0) {
    return (
      <DropdownMenuItem disabled className="text-xs italic">
        {t("workspace.tools.layoutMenu.noSavedLayoutsYet", "No saved layouts yet")}
      </DropdownMenuItem>
    );
  }
  return layouts.map((layout) => (
    <DropdownMenuItem key={layout.id} onSelect={() => onApply(layout)}>
      {layout.id === appliedLayoutId ? (
        <CheckIcon className="size-4" />
      ) : (
        <span className="size-4" />
      )}
      <span className="flex-1 truncate">{layout.name}</span>
      {layout.is_default && <StarIcon className="size-3.5 text-yellow-500" />}
    </DropdownMenuItem>
  ));
}

function DefaultLayoutSubmenu({
  layouts,
  onSetDefault,
}: {
  layouts: FeatureLayout[];
  onSetDefault: (layoutId: number) => void;
}): ReactNode {
  const { t } = useUiTranslation();
  if (layouts.length === 0) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {t("workspace.tools.layoutMenu.setDefault", "Set default")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {layouts.map((layout) => (
          <DropdownMenuItem key={layout.id} onSelect={() => onSetDefault(layout.id)}>
            {layout.is_default ? (
              <StarIcon className="size-3.5 text-yellow-500" />
            ) : (
              <span className="size-3.5" />
            )}
            <span className="ml-1 flex-1 truncate">{layout.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * End-of-strip menu for managing saved layouts. Lives at the right edge of
 * the root pane's tab strip.
 *
 * Items:
 *  - Saved layouts (click → apply)
 *  - Save as new layout… (modal prompt for a name)
 *  - Update "{applied}" (only when a saved layout is currently applied)
 *  - Set default ▸ (submenu listing layouts)
 *  - Delete "{applied}" (when applied layout exists)
 *  - Undo auto layout (when auto layout just rearranged the panes)
 *  - Reset layout (back to flat default)
 */
export function LayoutMenu({ featureId }: LayoutMenuProps): ReactNode {
  const { t } = useUiTranslation();
  const {
    layouts,
    defaultLayout,
    isLoading,
    saveAsNew,
    updateExisting,
    setDefault,
    deleteLayout,
    apply,
  } = useSavedLayouts(featureId);
  const appliedLayoutId = useFeatureLayoutStore(
    (s) => selectFeatureLayout(featureId)(s).appliedLayoutId,
  );
  const resetToFlat = useFeatureLayoutStore((s) => s.resetToFlat);
  const canUndoAuto = useAutoLayoutStore((s) => featureId in s.undo);

  const appliedLayout = layouts.find((l) => l.id === appliedLayoutId) ?? null;
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  return (
    <>
      <DropdownMenu>
        <LayoutMenuTrigger disabled={isLoading} />
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            {t("workspace.tools.layoutMenu.layouts", "Layouts")}
          </DropdownMenuLabel>
          <SavedLayoutItems layouts={layouts} appliedLayoutId={appliedLayoutId} onApply={apply} />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setSaveName("");
              setSaveOpen(true);
            }}
          >
            {t("workspace.tools.layoutMenu.saveAsNewLayout", "Save as new layout…")}
          </DropdownMenuItem>
          {appliedLayout && (
            <DropdownMenuItem onSelect={() => void updateExisting(appliedLayout.id)}>
              {t("workspace.tools.layoutMenu.updateNamed", "Update “{{name}}”", {
                name: appliedLayout.name,
              })}
            </DropdownMenuItem>
          )}
          <DefaultLayoutSubmenu
            layouts={layouts}
            onSetDefault={(layoutId) => void setDefault(layoutId)}
          />
          {appliedLayout && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => void deleteLayout(appliedLayout.id)}
            >
              {t("workspace.tools.layoutMenu.deleteNamed", "Delete “{{name}}”", {
                name: appliedLayout.name,
              })}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {canUndoAuto && (
            <DropdownMenuItem onSelect={() => undoAutoLayout(featureId)}>
              <Undo2Icon className="size-4" />
              {t("workspace.tools.layoutMenu.undoAutoLayout", "Undo auto layout")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              noteUserLayoutChange(featureId, { structural: true });
              resetToFlat(featureId);
            }}
          >
            {t("workspace.tools.layoutMenu.resetLayout", "Reset layout")}
          </DropdownMenuItem>
          {defaultLayout && (
            <DropdownMenuLabel className="text-xs italic text-muted-foreground">
              {t("workspace.tools.layoutMenu.defaultNamed", "Default: {{name}}", {
                name: defaultLayout.name,
              })}
            </DropdownMenuLabel>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <SaveAsNewDialog
        open={saveOpen}
        name={saveName}
        existingNames={layouts.map((l) => l.name)}
        onNameChange={setSaveName}
        onCancel={() => setSaveOpen(false)}
        onSubmit={async () => {
          const trimmed = saveName.trim();
          if (!trimmed) return;
          const created: FeatureLayout | null = await saveAsNew(trimmed);
          if (created) setSaveOpen(false);
        }}
      />
    </>
  );
}

interface SaveAsNewDialogProps {
  open: boolean;
  name: string;
  existingNames: string[];
  onNameChange: (next: string) => void;
  onCancel: () => void;
  onSubmit: () => Promise<void>;
}

function SaveAsNewDialog({
  open,
  name,
  existingNames,
  onNameChange,
  onCancel,
  onSubmit,
}: SaveAsNewDialogProps): ReactNode {
  const { t } = useUiTranslation();
  const trimmed = name.trim();
  const isDuplicate = trimmed.length > 0 && existingNames.includes(trimmed);
  const canSubmit = trimmed.length > 0 && !isDuplicate;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("workspace.tools.layoutMenu.saveLayoutAs", "Save layout as…")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            autoFocus
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t("workspace.tools.layoutMenu.myLayout", "My layout")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) {
                e.preventDefault();
                void onSubmit();
              }
            }}
          />
          {isDuplicate && (
            <p className="text-xs text-destructive">
              {t(
                "workspace.tools.layoutMenu.duplicateName",
                "A layout named “{{name}}” already exists.",
                { name: trimmed },
              )}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("workspace.tools.layoutMenu.cancel", "Cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void onSubmit()}>
            {t("workspace.tools.layoutMenu.save", "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LayoutMenuTrigger({ disabled }: { disabled: boolean }): ReactNode {
  const { t } = useUiTranslation();
  return (
    <DropdownMenuTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={t("workspace.tools.layoutMenu.layoutOptions", "Layout options")}
        disabled={disabled}
      >
        <LayoutTemplateIcon className="size-4" />
      </Button>
    </DropdownMenuTrigger>
  );
}

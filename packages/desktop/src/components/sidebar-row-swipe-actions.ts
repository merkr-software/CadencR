import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  PinIcon,
  PinOffIcon,
  TrashIcon,
} from "lucide-react";
import {
  getUpdateFeaturePinnedMutationKey,
  getUpdateFeatureStatusMutationKey,
} from "@/api/generated";
import type { RowSwipeAction } from "@/components/SidebarRowSwipeTray";
import { archiveActionLabel, pinActionLabel } from "@/components/ProjectFeatureRowParts";
import { translateUi } from "@/lib/i18n/ui";

interface FeatureSwipeActionsInput {
  featureId: number;
  /** The conversation's title, named in each action's accessible name. */
  title: string;
  isArchived: boolean;
  isPinned: boolean;
  onTogglePin: (featureId: number, pinned: boolean) => void;
  /** Opens the archive dialog of an active conversation, the delete one of an archived one. */
  onArchiveOrDelete: () => void;
  onUnarchive?: (featureId: number) => void;
  /** A For me row's "Mark done", when its next action can be marked. */
  onMarkDone?: () => void;
}

/**
 * The actions a conversation row's swipe reveals on phone, the same ones its
 * hover buttons and context menu run on desktop: Pin (or Unpin) and Archive
 * on an active conversation, Unarchive and Delete on an archived one; a For
 * me row leads with Mark done.
 */
export function featureSwipeActions({
  featureId,
  title,
  isArchived,
  isPinned,
  onTogglePin,
  onArchiveOrDelete,
  onUnarchive,
  onMarkDone,
}: FeatureSwipeActionsInput): RowSwipeAction[] {
  const named = (label: string): Pick<RowSwipeAction, "label" | "ariaLabel"> => ({
    label,
    ariaLabel: translateUi("phone.actionOnConversation", "{{action}} “{{title}}”", {
      action: label,
      title,
    }),
  });
  const actions: RowSwipeAction[] = [];
  if (onMarkDone) {
    actions.push({
      key: "done",
      ...named(translateUi("common.done", "Done")),
      icon: CheckIcon,
      onSelect: onMarkDone,
    });
  }
  if (isArchived) {
    if (onUnarchive) {
      actions.push({
        key: "unarchive",
        ...named(translateUi("project.featureContextMenu.unarchive", "Unarchive")),
        icon: ArchiveRestoreIcon,
        onSelect: () => onUnarchive(featureId),
        mutationKey: getUpdateFeatureStatusMutationKey(),
      });
    }
  } else {
    actions.push({
      key: "pin",
      ...named(pinActionLabel(isPinned)),
      icon: isPinned ? PinOffIcon : PinIcon,
      onSelect: () => onTogglePin(featureId, !isPinned),
      mutationKey: getUpdateFeaturePinnedMutationKey(),
    });
  }
  actions.push({
    key: "archive",
    ...named(archiveActionLabel(isArchived)),
    icon: isArchived ? TrashIcon : ArchiveIcon,
    onSelect: onArchiveOrDelete,
    tone: isArchived ? "destructive" : "primary",
  });
  return actions;
}

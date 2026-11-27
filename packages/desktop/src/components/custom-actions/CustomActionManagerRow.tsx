import { useUiTranslation } from "@/lib/i18n/ui";
import { useState, type ReactElement } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";

import type { CustomAction } from "@/api/generated";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CustomActionIcon } from "./CustomActionIcon";

interface CustomActionManagerRowProps {
  action: CustomAction;
  index: number;
  count: number;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropOn: () => void;
  onMove: (toIndex: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** One action in a settings list. Drag the grip, or use the menu, to reorder. */
export function CustomActionManagerRow({
  action,
  index,
  count,
  dragging,
  onDragStart,
  onDragEnd,
  onDropOn,
  onMove,
  onEdit,
  onDelete,
}: CustomActionManagerRowProps): ReactElement {
  const { t } = useUiTranslation();
  const [dropTarget, setDropTarget] = useState(false);
  return (
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(action.id));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        event.preventDefault();
        setDropTarget(true);
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDropTarget(false);
        onDropOn();
      }}
      className={cn(
        "group flex items-center gap-2 px-2 py-2 transition-colors",
        dragging && "opacity-50",
        dropTarget && !dragging && "bg-accent",
      )}
    >
      <GripVerticalIcon
        aria-hidden
        className="size-4 shrink-0 cursor-grab text-muted-foreground/60 group-hover:text-muted-foreground"
      />
      <CustomActionIcon iconData={action.icon_data} name={action.name} className="size-4" />
      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="flex items-center gap-2 text-sm">
          <span className="truncate">{action.name}</span>
          {action.run_in_terminal && (
            <span className="rounded-sm bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
              {t("customActions.customActionManagerRow.terminal", "Terminal")}
            </span>
          )}
        </span>
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {action.command}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("customActions.options", "{{name}} options", { name: action.name })}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <PencilIcon />
            {t("customActions.customActionManagerRow.edit", "Edit…")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(index - 1)}>
            <ArrowUpIcon />
            {t("customActions.customActionManagerRow.moveUp", "Move up")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index === count - 1} onSelect={() => onMove(index + 1)}>
            <ArrowDownIcon />
            {t("customActions.customActionManagerRow.moveDown", "Move down")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2Icon />
            {t("customActions.deleteAction", "Delete…")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

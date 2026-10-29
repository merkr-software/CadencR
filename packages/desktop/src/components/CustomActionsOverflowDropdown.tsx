import { useRef, type ReactElement } from "react";
import { MoreHorizontalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CustomAction } from "@/api/generated";
import { CustomActionIcon } from "./CustomActionIcon";
import { CustomActionStatusDot, customActionStatus } from "./CustomActionStatusDot";

interface CustomActionsOverflowDropdownProps {
  actions: CustomAction[];
  /** Bar-level callback to open the shared details/output surface for an action. */
  onOpenDetails: (action: CustomAction) => void;
}

/**
 * Dropdown for every action that doesn't fit inline. Each entry shows the same
 * live status dot as an inline button and opens the same details/output
 * surface — so an overflow action is never a dead end for run status or output.
 *
 * Opening the details popover is deferred to the menu's `onCloseAutoFocus`: the
 * menu's teardown (focus return + pointer events) would otherwise dismiss a
 * popover opened synchronously from `onSelect`.
 */
export function CustomActionsOverflowDropdown({
  actions,
  onOpenDetails,
}: CustomActionsOverflowDropdownProps): ReactElement {
  const pendingRef = useRef<CustomAction | null>(null);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 text-xs" title="More actions">
          <MoreHorizontalIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        onCloseAutoFocus={(event) => {
          const pending = pendingRef.current;
          if (!pending) return;
          pendingRef.current = null;
          event.preventDefault();
          onOpenDetails(pending);
        }}
      >
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            onSelect={() => {
              pendingRef.current = action;
            }}
          >
            <span className="relative inline-flex items-center justify-center">
              <CustomActionIcon iconData={action.icon_data ?? null} name={action.name} />
              <CustomActionStatusDot lastRun={action.last_run ?? null} isRunning={false} />
            </span>
            <span className="truncate">{action.name}</span>
            <OverflowStatusText action={action} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Screen-reader copy of the decorative status dot; silent for never-run actions. */
function OverflowStatusText({ action }: { action: CustomAction }): ReactElement | null {
  const status = customActionStatus(action.last_run ?? null, false);
  if (status.color == null) return null;
  return <span className="sr-only">, {status.label}</span>;
}

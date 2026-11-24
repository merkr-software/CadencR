import type { ReactElement, ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A 44px icon button in `PhoneViewerHeader`. */
export const PHONE_VIEWER_BUTTON =
  "size-11 rounded-none text-muted-foreground hover:text-foreground";

/**
 * The header of a full-screen viewer on the phone layout (a diagram, a
 * table, a code block): its title, then its own actions, then Close, every
 * button a 44px target.
 */
export function PhoneViewerHeader({
  title,
  closeLabel = "Close",
  onClose,
  children,
}: {
  title: string;
  closeLabel?: string;
  onClose: () => void;
  /** The viewer's actions, before Close. */
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="flex h-11 shrink-0 items-center border-b border-border pl-4 [&_button]:size-11">
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
      {children}
      <Button
        variant="ghost"
        className={PHONE_VIEWER_BUTTON}
        aria-label={closeLabel}
        title={closeLabel}
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </div>
  );
}

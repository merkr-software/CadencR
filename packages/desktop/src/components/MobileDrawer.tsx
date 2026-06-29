import { type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface MobileDrawerProps {
  /** Whether the drawer is hidden (slid off-canvas to the left). */
  collapsed: boolean;
  /** Dismiss the drawer — wired to the backdrop tap. */
  onClose: () => void;
  /** Accessible label for the backdrop dismiss button. */
  closeLabel: string;
  /** Drawer contents (the sidebar/tree). */
  children: ReactNode;
}

/**
 * Off-canvas left drawer for mobile sidebars: a dimmed backdrop plus an 85vw
 * panel that slides in from the left. Render it as the last children of a
 * `relative` container — it positions `absolute` within that container (not
 * `fixed`) so it tracks the shell height on iOS standalone, where a `fixed` box
 * resolves to the short top-anchored viewport and would clip the bottom.
 *
 * Shared by the app shell (`AppShell`) and the editor's file-tree layout
 * (`EditorSidebarLayout`) so the backdrop, width, and slide animation live in
 * one place.
 */
export function MobileDrawer({
  collapsed,
  onClose,
  closeLabel,
  children,
}: MobileDrawerProps): ReactElement {
  return (
    <>
      <button
        type="button"
        aria-label={closeLabel}
        tabIndex={-1}
        onClick={onClose}
        className={cn(
          "absolute inset-0 z-40 bg-black/50 transition-opacity duration-200",
          collapsed ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      />
      <div
        className={cn(
          "absolute inset-y-0 left-0 z-50 w-[85vw] max-w-xs transform shadow-xl transition-transform duration-200 ease-out",
          collapsed ? "-translate-x-full" : "translate-x-0",
        )}
      >
        {children}
      </div>
    </>
  );
}

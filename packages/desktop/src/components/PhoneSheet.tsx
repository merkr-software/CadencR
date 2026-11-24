import type { ComponentProps, ReactElement } from "react";

import { DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * A bottom sheet for the phone layout: the `Dialog` content pinned to the
 * bottom edge, full width, top corners rounded, clear of the home indicator.
 * It never autofocuses (that would raise the on-screen keyboard over it).
 */
const PHONE_SHEET_CLASS = cn(
  "flex flex-col gap-0 overflow-hidden p-0",
  "top-auto bottom-0 left-0 w-full max-w-none translate-x-0 translate-y-0 sm:max-w-none",
  "rounded-t-2xl rounded-b-none border-x-0 border-b-0",
  "max-h-[85dvh] pb-[env(safe-area-inset-bottom)]",
  "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
  "data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100",
);

export function PhoneSheetContent({
  className,
  onOpenAutoFocus,
  ...props
}: ComponentProps<typeof DialogContent>): ReactElement {
  return (
    <DialogContent
      showCloseButton={false}
      className={cn(PHONE_SHEET_CLASS, className)}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        onOpenAutoFocus?.(event);
      }}
      {...props}
    />
  );
}

/** A full-width 44px row of a phone sheet. */
export const PHONE_SHEET_ROW_CLASS = cn(
  "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left text-sm",
  "outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
  "disabled:pointer-events-none disabled:text-muted-foreground",
);

/** A section heading inside a phone sheet. */
export function PhoneSheetHeading({
  children,
  className,
}: {
  children: ComponentProps<"h3">["children"];
  className?: string;
}): ReactElement {
  return (
    <h3 className={cn("px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground", className)}>
      {children}
    </h3>
  );
}

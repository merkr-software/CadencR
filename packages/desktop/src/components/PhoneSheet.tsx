import { createContext, useContext, type ComponentProps, type ReactElement } from "react";

import { DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * A bottom sheet for the phone layout: the `Dialog` content pinned to the
 * bottom of the app viewport, full width, top corners rounded, a grab handle on
 * top, clear of the home indicator, at most 85% of that viewport. The app
 * viewport (`--app-vh`) shrinks with the on-screen keyboard, so the sheet rises
 * above it when one of its fields is focused, where the screen's bottom edge
 * would leave it under the keyboard. It never autofocuses (that would raise
 * the on-screen keyboard over it).
 */
const PHONE_SHEET_CLASS = cn(
  "flex flex-col gap-0 overflow-hidden p-0",
  "top-(--app-vh,100dvh) bottom-auto left-0 w-full max-w-none translate-x-0 -translate-y-full sm:max-w-none",
  "rounded-t-2xl rounded-b-none border-x-0 border-b-0",
  "max-h-[calc(var(--app-vh,100dvh)*0.85)] pb-(--app-inset-bottom)",
  "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
  "data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100",
);

export function PhoneSheetContent({
  className,
  children,
  onOpenAutoFocus,
  ...props
}: ComponentProps<typeof DialogContent>): ReactElement {
  return (
    <DialogContent
      showCloseButton={false}
      data-phone-sheet=""
      className={cn(PHONE_SHEET_CLASS, className)}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        onOpenAutoFocus?.(event);
      }}
      {...props}
    >
      {/* Decorative: a sheet reads as one you can pull down, though the
          backdrop, Escape or an action closes it. */}
      <div
        aria-hidden="true"
        className="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30"
      />
      {children}
    </DialogContent>
  );
}

/** A full-width 44px row of a phone sheet. */
export const PHONE_SHEET_ROW_CLASS = cn(
  "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left text-sm",
  "outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
  "disabled:pointer-events-none disabled:text-muted-foreground",
);

/** The type of a phone sheet's headings, its title shown included. */
const PHONE_SHEET_HEADING_CLASS = "px-4 pb-1 text-xs font-medium text-muted-foreground";

/** The scrolling body of a phone sheet of rows, under its title. */
export const PHONE_SHEET_BODY_CLASS = "flex min-h-0 flex-col overflow-y-auto px-2 pb-2";

/** A section heading inside a phone sheet. */
export function PhoneSheetHeading({
  children,
  className,
}: {
  children: ComponentProps<"h3">["children"];
  className?: string;
}): ReactElement {
  return <h3 className={cn(PHONE_SHEET_HEADING_CLASS, "pt-3", className)}>{children}</h3>;
}

/**
 * Set by `AdaptivePopover` / `AdaptiveMenu` (`PhoneSheetMenu.tsx`): whether
 * their parts render as a phone sheet. Read through `useInPhoneSheet`.
 */
export const PhoneSheetModeContext = createContext(false);

/**
 * Inside an adaptive popover or menu: `true` when it renders as a phone sheet,
 * so its content can drop desktop-only behavior (focusing the composer after a
 * pick, a search field's autofocus) or grow its rows.
 */
export function useInPhoneSheet(): boolean {
  return useContext(PhoneSheetModeContext);
}

/**
 * The sheet's name: a sheet is a dialog and needs one, where the popover it
 * replaces had none. Shown as the sheet's heading, or for screen readers only.
 */
export function PhoneSheetTitle({
  title,
  visible,
}: {
  title: string;
  visible: boolean;
}): ReactElement {
  return (
    <DialogTitle className={visible ? cn(PHONE_SHEET_HEADING_CLASS, "pt-2") : "sr-only"}>
      {title}
    </DialogTitle>
  );
}

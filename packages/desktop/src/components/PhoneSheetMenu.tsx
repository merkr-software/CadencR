import {
  useContext,
  type AriaAttributes,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  PHONE_SHEET_BODY_CLASS,
  PHONE_SHEET_ROW_CLASS,
  PhoneSheetContent,
  PhoneSheetHeading,
  PhoneSheetModeContext,
  PhoneSheetTitle,
} from "@/components/PhoneSheet";
import { Dialog, DialogClose, DialogTrigger } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";

/**
 * A popover or a dropdown menu on the desktop layout, a bottom sheet
 * (`PhoneSheetContent`) on the phone layout: same parts, same content, same
 * open state. The sheet takes nothing from the popper (side, align, offsets);
 * it never autofocuses, so the consumer's `onOpenAutoFocus` and
 * `onCloseAutoFocus` are desktop-only: the sheet raises no keyboard on open
 * and gives focus back to its trigger on close.
 */
interface AdaptiveRootProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

/** The sheet's own props, beside the desktop popover's. */
interface SheetProps {
  /** The sheet's accessible name (a popover has none). */
  sheetTitle: string;
  /** Shows `sheetTitle` as the sheet's heading instead of to screen readers only. */
  sheetTitleVisible?: boolean;
  /** Classes for the sheet; `className` styles the desktop popover only. */
  sheetClassName?: string;
}

/** The popover's own sheet props. */
interface PopoverSheetProps extends SheetProps {
  /**
   * Lays the content out as `AdaptiveMenuContent` does: rows in a scrolling
   * body under the title, which `sheetClassName` then styles.
   */
  sheetRows?: boolean;
}

function AdaptiveRoot({
  menu,
  children,
  ...rootProps
}: AdaptiveRootProps & { menu: boolean }): ReactElement {
  const phone = useIsMobile();
  let root: ReactElement;
  if (phone) root = <Dialog {...rootProps}>{children}</Dialog>;
  else if (menu) root = <DropdownMenu {...rootProps}>{children}</DropdownMenu>;
  else root = <Popover {...rootProps}>{children}</Popover>;
  return <PhoneSheetModeContext.Provider value={phone}>{root}</PhoneSheetModeContext.Provider>;
}

/** Arbitrary content: a `Popover` on desktop, a sheet on phone. */
export function AdaptivePopover(props: AdaptiveRootProps): ReactElement {
  return <AdaptiveRoot menu={false} {...props} />;
}

export function AdaptivePopoverTrigger(props: ComponentProps<typeof PopoverTrigger>): ReactElement {
  return useContext(PhoneSheetModeContext) ? (
    <DialogTrigger {...props} />
  ) : (
    <PopoverTrigger {...props} />
  );
}

export function AdaptivePopoverContent({
  sheetTitle,
  sheetTitleVisible = false,
  sheetClassName,
  sheetRows = false,
  ...props
}: ComponentProps<typeof PopoverContent> & PopoverSheetProps): ReactElement {
  if (!useContext(PhoneSheetModeContext)) return <PopoverContent {...props} />;
  return (
    <PhoneSheetContent
      className={sheetRows ? undefined : sheetClassName}
      onEscapeKeyDown={props.onEscapeKeyDown}
      onKeyDown={props.onKeyDown}
    >
      <PhoneSheetTitle title={sheetTitle} visible={sheetTitleVisible} />
      {sheetRows ? (
        <div className={cn(PHONE_SHEET_BODY_CLASS, sheetClassName)}>{props.children}</div>
      ) : (
        props.children
      )}
    </PhoneSheetContent>
  );
}

/** A list of actions: a `DropdownMenu` on desktop, a sheet of 44px rows on phone. */
export function AdaptiveMenu(props: AdaptiveRootProps): ReactElement {
  return <AdaptiveRoot menu {...props} />;
}

export function AdaptiveMenuTrigger(
  props: ComponentProps<typeof DropdownMenuTrigger>,
): ReactElement {
  return useContext(PhoneSheetModeContext) ? (
    <DialogTrigger {...props} />
  ) : (
    <DropdownMenuTrigger {...props} />
  );
}

export function AdaptiveMenuContent({
  sheetTitle,
  sheetTitleVisible = false,
  sheetClassName,
  ...props
}: ComponentProps<typeof DropdownMenuContent> & SheetProps): ReactElement {
  if (!useContext(PhoneSheetModeContext)) return <DropdownMenuContent {...props} />;
  return (
    <PhoneSheetContent onEscapeKeyDown={props.onEscapeKeyDown}>
      <PhoneSheetTitle title={sheetTitle} visible={sheetTitleVisible} />
      <div className={cn(PHONE_SHEET_BODY_CLASS, sheetClassName)}>{props.children}</div>
    </PhoneSheetContent>
  );
}

/** A menu item's parts that both renderings share; ARIA states reach either one. */
interface AdaptiveMenuItemProps extends AriaAttributes {
  className?: string;
  children?: ReactNode;
  disabled?: boolean;
  onSelect?: (event: Event) => void;
  variant?: "default" | "destructive";
}

/**
 * A menu item; on phone a 44px row that runs `onSelect` and closes the sheet,
 * unless `onSelect` calls `preventDefault()` on its event (as with Radix).
 */
export function AdaptiveMenuItem({
  className,
  children,
  disabled,
  onSelect,
  variant = "default",
  ...aria
}: AdaptiveMenuItemProps): ReactElement {
  if (!useContext(PhoneSheetModeContext)) {
    return (
      <DropdownMenuItem
        {...aria}
        className={className}
        disabled={disabled}
        onSelect={onSelect}
        variant={variant}
      >
        {children}
      </DropdownMenuItem>
    );
  }
  return (
    <DialogClose asChild>
      <button
        {...aria}
        type="button"
        disabled={disabled}
        className={cn(
          PHONE_SHEET_ROW_CLASS,
          variant === "destructive" && "text-destructive",
          "[&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
          className,
        )}
        onClick={(event) => {
          const select = new Event("select", { cancelable: true });
          onSelect?.(select);
          if (select.defaultPrevented) event.preventDefault();
        }}
      >
        {children}
      </button>
    </DialogClose>
  );
}

/** A group label: the menu's own on desktop, a sheet heading on phone. */
export function AdaptiveMenuLabel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): ReactElement {
  return useContext(PhoneSheetModeContext) ? (
    <PhoneSheetHeading className="flex items-center justify-between px-2">
      {children}
    </PhoneSheetHeading>
  ) : (
    <DropdownMenuLabel className={className}>{children}</DropdownMenuLabel>
  );
}

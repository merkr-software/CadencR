import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Whether popovers below this point open modally. See {@link PopoverModality}.
 */
const PopoverModalityContext = React.createContext(false);

/**
 * Makes every popover inside modal — the fix for "the list won't scroll".
 *
 * A Radix dialog locks the page with react-remove-scroll, which cancels wheel
 * events whose target sits outside the dialog's own subtree. Popover content is
 * portaled to the body, so a picker opened inside a dialog looks scrollable and
 * isn't: the branch list and the model list both dead-stop on the wheel. A modal
 * popover installs its own scroll lock, which takes over while it is open.
 *
 * Wrap the dialog's content in this rather than threading a `modal` prop through
 * every picker it happens to contain.
 */
function PopoverModality({
  modal = true,
  children,
}: {
  modal?: boolean;
  children: React.ReactNode;
}) {
  return (
    <PopoverModalityContext.Provider value={modal}>{children}</PopoverModalityContext.Provider>
  );
}

function Popover({ modal, ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const inheritedModality = React.useContext(PopoverModalityContext);
  return (
    <PopoverPrimitive.Root data-slot="popover" modal={modal ?? inheritedModality} {...props} />
  );
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverAnchor, PopoverModality, PopoverTrigger, PopoverContent };

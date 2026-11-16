"use client";

import { useEffect, useRef } from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels";

import { cn } from "@/lib/utils";
import { registerHandle, unregisterHandle } from "@/lib/resize-coordinator";

function ResizablePanelGroup({ className, ...props }: GroupProps) {
  return (
    <Group
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full", className)}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: PanelProps) {
  return <Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({ className, ...props }: SeparatorProps) {
  // Hand the handle element to the resize-coordinator. It maintains a single
  // document-level capture-phase pointerdown listener that uses geometric
  // proximity to detect drag starts, mirroring react-resizable-panels' own
  // hit detection. See `lib/resize-coordinator.ts` for the rationale —
  // briefly: the library accepts clicks within ~5 px of a 1 px handle (its
  // `resizeTargetMinimumSize.fine` minimum), but DOM hit-testing routes
  // those clicks to whichever element wins CSS stacking, which is often
  // *not* the handle. A per-element pointerdown listener therefore misses
  // a meaningful fraction of real drags.
  const handleElRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = handleElRef.current;
    if (!el) return;
    registerHandle(el);
    return () => unregisterHandle(el);
  }, []);

  // react-resizable-panels v4 emits `aria-orientation` on the Separator (the
  // line direction — opposite of the group's resize axis). We drive sizing and
  // hit-zone positioning off that attribute. Note: v4 does NOT emit
  // `data-panel-group-direction`, so older shadcn templates that key off it
  // silently break vertical resizing — the separator keeps `w-px` and collapses
  // to zero height in a column flexbox.
  //
  // - aria-orientation="vertical"   → vertical line, horizontal panel group
  // - aria-orientation="horizontal" → horizontal line, vertical panel group
  return (
    <Separator
      data-slot="resizable-handle"
      elementRef={handleElRef}
      className={cn(
        "group relative flex items-center justify-center transition-opacity",
        // Line size per orientation.
        "aria-[orientation=vertical]:w-px",
        "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
        // Dashed gray separator, hover-only: a repeating gradient renders the
        // line as 4px segments of `--border` separated by 4px gaps. A linear
        // mask fades the dashes in/out at the ends so the line feels soft
        // instead of clipped against the pane chrome. Invisible at rest;
        // appears on hover so the split surface stays clean unless the user
        // is about to grab the handle.
        "aria-[orientation=vertical]:hover:[background:repeating-linear-gradient(to_bottom,var(--border)_0_4px,transparent_4px_8px)]",
        "aria-[orientation=vertical]:hover:[mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]",
        "aria-[orientation=horizontal]:hover:[background:repeating-linear-gradient(to_right,var(--border)_0_4px,transparent_4px_8px)]",
        "aria-[orientation=horizontal]:hover:[mask-image:linear-gradient(to_right,transparent,black_20%,black_80%,transparent)]",
        // Generous 16px hit zone via ::after, expanded across the resize axis.
        "after:absolute after:content-['']",
        "aria-[orientation=vertical]:after:inset-y-0 aria-[orientation=vertical]:after:-left-2 aria-[orientation=vertical]:after:-right-2",
        "aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:-top-2 aria-[orientation=horizontal]:after:-bottom-2",
        "focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden",
        // Disabled (the library sets aria-disabled): keep the pixel, show
        // nothing — no hover line or grip, no not-allowed cursor — and take
        // no pointer. `resize-coordinator` skips it as well.
        "aria-disabled:pointer-events-none aria-disabled:invisible",
        className,
      )}
      {...props}
    >
      {/* Hover grip: a small pill centred on the handle, fading in when the
          user mouses over the hit zone. Makes "this is draggable" obvious
          without painting a permanent UI element. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none z-10 rounded-full bg-foreground/40 opacity-0 transition-opacity duration-150 group-hover:opacity-100",
          "group-aria-[orientation=vertical]:h-8 group-aria-[orientation=vertical]:w-1.5",
          "group-aria-[orientation=horizontal]:h-1.5 group-aria-[orientation=horizontal]:w-8",
        )}
      />
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };

import { useLayoutEffect, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/lib/desktop-bridge";
import { cn } from "@/lib/utils";

type WindowControlKind = "minimize" | "maximize" | "close";

interface WindowControl {
  kind: WindowControlKind;
  label: string;
}

const WINDOW_CONTROLS_DATA_KEY = "windowControls";
const CONTROLS: WindowControl[] = [
  { kind: "minimize", label: "Minimize window" },
  { kind: "maximize", label: "Toggle maximize window" },
  { kind: "close", label: "Close window" },
];

export function AppWindowControls(): ReactElement | null {
  const enabled = desktopBridge.isElectron && desktopBridge.usesCustomWindowControls === true;

  useLayoutEffect((): (() => void) | undefined => {
    if (!enabled) return undefined;
    document.documentElement.dataset[WINDOW_CONTROLS_DATA_KEY] = "linux";
    return () => {
      delete document.documentElement.dataset[WINDOW_CONTROLS_DATA_KEY];
    };
  }, [enabled]);

  if (!enabled) return null;

  return createPortal(
    <div
      data-app-window-controls
      className="titlebar-no-drag fixed top-0 right-0 flex h-12 items-center justify-end gap-1.5 px-2"
    >
      {CONTROLS.map((control) => (
        <WindowControlButton key={control.kind} control={control} />
      ))}
    </div>,
    document.body,
  );
}

function WindowControlButton({ control }: { control: WindowControl }): ReactElement {
  const isClose = control.kind === "close";

  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={control.label}
      title={control.label}
      data-app-window-control-button
      data-window-control={control.kind}
      className={cn(
        "titlebar-no-drag group/window-control size-auto h-9 w-10 rounded-md border border-transparent p-0",
        "text-muted-foreground hover:-translate-y-px hover:border-border hover:bg-accent hover:text-foreground hover:shadow-sm",
        isClose &&
          "hover:border-destructive hover:bg-destructive hover:text-destructive-foreground",
      )}
      onClick={() => {
        void runWindowAction(control.kind).catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : `${control.label} failed`);
        });
      }}
    >
      <WindowControlIcon kind={control.kind} />
    </Button>
  );
}

function WindowControlIcon({ kind }: { kind: WindowControlKind }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 transition-transform duration-150 ease-out group-hover/window-control:scale-110"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === "minimize" && <path d="M4 8h8" />}
      {kind === "maximize" && <rect x="4.5" y="4.5" width="7" height="7" rx="0.8" />}
      {kind === "close" && (
        <>
          <path d="M5 5l6 6" />
          <path d="M11 5l-6 6" />
        </>
      )}
    </svg>
  );
}

function runWindowAction(kind: WindowControlKind): Promise<void> {
  if (kind === "minimize") return desktopBridge.windowMinimize?.() ?? unavailable(kind);
  if (kind === "maximize") return desktopBridge.windowToggleMaximize?.() ?? unavailable(kind);
  return desktopBridge.windowClose?.() ?? desktopBridge.requestQuit();
}

function unavailable(kind: WindowControlKind): Promise<never> {
  return Promise.reject(new Error(`Window ${kind} is unavailable.`));
}

import { useEffect, useState, type ReactElement } from "react";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface InternetStatusIndicatorProps {
  className?: string;
}

function readNavigatorOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

export function InternetStatusIndicator({
  className,
}: InternetStatusIndicatorProps): ReactElement | null {
  const [isOnline, setIsOnline] = useState(readNavigatorOnline);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function syncOnlineState(): void {
      setIsOnline(readNavigatorOnline());
    }

    syncOnlineState();
    window.addEventListener("online", syncOnlineState);
    window.addEventListener("offline", syncOnlineState);
    return () => {
      window.removeEventListener("online", syncOnlineState);
      window.removeEventListener("offline", syncOnlineState);
    };
  }, []);

  if (isOnline) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="No internet connection"
          className={cn(
            "inline-flex size-5 items-center justify-center rounded-full",
            "text-[var(--acc-orange)] opacity-75 transition-opacity hover:opacity-100",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--acc-orange)]",
            className,
          )}
          onBlur={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <WifiOff className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-64 text-xs">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 font-semibold text-[var(--acc-orange)]">
            <WifiOff className="size-3.5" aria-hidden />
            <span>No internet connection</span>
          </div>
          <p className="text-muted-foreground leading-relaxed">
            Cloud models may be unavailable while local work can continue.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

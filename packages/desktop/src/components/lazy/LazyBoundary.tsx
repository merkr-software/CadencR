import {
  Component,
  Suspense,
  useLayoutEffect,
  useRef,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGlobalShortcut } from "@/hooks/useGlobalShortcut";
import { cn } from "@/lib/utils";
import { LazyChunkError } from "./lazy-chunk";

type LazyVariant = "panel" | "inline" | "overlay";

/**
 * `panel` fills its container and centers the state (a tab body, a page);
 * `inline` is one compact line (inside a dialog); `overlay` floats in the
 * middle of the window (a dialog that is not open yet) and takes the keys
 * while it shows: Escape calls `onDismiss`, which must reset whatever opened
 * it, and the failure offers Close beside Reload.
 */
type LazyVariantProps =
  | { variant?: "panel" | "inline"; onDismiss?: never }
  | { variant: "overlay"; onDismiss: () => void };

type LazyBoundaryProps = LazyVariantProps & {
  /** What is loading, as the user calls it: "Terminal", "Git", "Settings". */
  label: string;
  children: ReactNode;
};

/**
 * The loading and failure states of a `lazyChunk` component: a spinner with
 * "Loading <label>…" while its chunk downloads, and "Couldn't load <label>"
 * with Reload when it fails (a reload fetches the host's current chunks, which
 * also covers an update that removed the old ones). Only a chunk failure stops
 * here; any other error rethrows to the boundary above, as without it.
 */
export function LazyBoundary({
  label,
  variant = "panel",
  onDismiss,
  children,
}: LazyBoundaryProps): ReactElement {
  return (
    <ChunkErrorBoundary label={label} variant={variant} onDismiss={onDismiss}>
      <Suspense fallback={<LazyLoading label={label} variant={variant} onDismiss={onDismiss} />}>
        {children}
      </Suspense>
    </ChunkErrorBoundary>
  );
}

const STATE_CLASS: Record<LazyVariant, string> = {
  panel:
    "flex h-full min-h-24 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground",
  inline: "flex min-h-11 items-center justify-center gap-2 px-3 text-sm text-muted-foreground",
  overlay:
    "fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md border border-border bg-background px-4 py-3 text-sm shadow-lg outline-none",
};

interface LazyStateProps {
  label: string;
  variant: LazyVariant;
  /** Overlay only: Escape (and the failure's Close) calls it. */
  onDismiss?: () => void;
}

export function LazyLoading({ label, variant, onDismiss }: LazyStateProps): ReactElement {
  const ref = useOverlayKeys(variant, onDismiss);
  return (
    <div
      ref={ref}
      role="status"
      tabIndex={variant === "overlay" ? -1 : undefined}
      className={STATE_CLASS[variant]}
    >
      <Loader2Icon
        aria-hidden
        className={cn("animate-spin", variant === "panel" ? "size-5" : "size-4")}
      />
      <span>Loading {label}…</span>
    </div>
  );
}

interface ChunkErrorBoundaryProps extends LazyStateProps {
  children: ReactNode;
}

class ChunkErrorBoundary extends Component<ChunkErrorBoundaryProps, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (error instanceof LazyChunkError) {
      console.error(`[lazy] ${this.props.label} failed to load`, error.cause, info.componentStack);
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    // Not ours: let the root boundary report it as it would without this one.
    if (!(error instanceof LazyChunkError)) throw error;
    const { label, variant, onDismiss } = this.props;
    return <LazyFailed label={label} variant={variant} onDismiss={onDismiss} />;
  }
}

export function LazyFailed({ label, variant, onDismiss }: LazyStateProps): ReactElement {
  const ref = useOverlayKeys(variant, onDismiss);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={variant === "overlay" ? -1 : undefined}
      className={STATE_CLASS[variant]}
    >
      <span className="text-destructive">Couldn’t load {label}. Check the connection.</span>
      <Button
        variant="outline"
        size="sm"
        className="phone:min-h-11"
        onClick={() => window.location.reload()}
      >
        Reload
      </Button>
      {variant === "overlay" && onDismiss && (
        <Button variant="ghost" size="sm" className="phone:min-h-11" onClick={onDismiss}>
          Close
        </Button>
      )}
    </div>
  );
}

/**
 * An overlay stands in for a dialog that is not there yet, so it takes the
 * keys the dialog would: it holds the focus while it shows (what is typed
 * does not land in the composer or the terminal behind it) and Escape
 * dismisses it. It hands the focus back as it goes, before the dialog that
 * replaces it mounts, so that dialog returns it to the same place on close.
 */
function useOverlayKeys(
  variant: LazyVariant,
  onDismiss: (() => void) | undefined,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const overlay = variant === "overlay";
  useLayoutEffect(() => {
    const node = ref.current;
    if (!overlay || !node) return undefined;
    const previous = document.activeElement;
    node.focus({ preventScroll: true });
    return () => {
      // Only if the focus is still ours: a click elsewhere moved it on.
      if (document.activeElement !== node && document.activeElement !== document.body) return;
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [overlay]);
  useGlobalShortcut(
    "Escape",
    (event) => {
      event.preventDefault();
      onDismiss?.();
    },
    { enabled: overlay && onDismiss !== undefined },
  );
  return ref;
}

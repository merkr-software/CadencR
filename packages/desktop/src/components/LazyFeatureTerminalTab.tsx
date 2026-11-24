import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useRef,
  type ComponentProps,
} from "react";
import { LazyBoundary } from "@/components/lazy/LazyBoundary";
import { lazyChunk } from "@/components/lazy/lazy-chunk";
import type { FeatureTerminalTabHandle } from "@/components/FeatureTerminalTab";

const FeatureTerminalTabChunk = lazyChunk(() =>
  import("@/components/FeatureTerminalTab").then((module) => module.FeatureTerminalTab),
);

type FeatureTerminalTabProps = Omit<ComponentProps<typeof FeatureTerminalTabChunk>, "ref">;

/**
 * The terminal tab from its own chunk, under its `LazyBoundary`. Its handle is
 * there from the first commit: an `activate()` that arrives while the chunk
 * still loads (a requested terminal focus on a conversation's first open) is
 * kept and run once the terminal mounts, instead of falling on a null ref.
 */
export const LazyFeatureTerminalTab = memo(
  forwardRef<FeatureTerminalTabHandle, FeatureTerminalTabProps>(
    function LazyFeatureTerminalTab(props, ref) {
      const inner = useRef<FeatureTerminalTabHandle | null>(null);
      const pendingActivate = useRef(false);
      const attach = useCallback((handle: FeatureTerminalTabHandle | null): void => {
        inner.current = handle;
        if (handle && pendingActivate.current) {
          pendingActivate.current = false;
          handle.activate();
        }
      }, []);
      useImperativeHandle(
        ref,
        () => ({
          activate: () => {
            if (inner.current) inner.current.activate();
            else pendingActivate.current = true;
          },
        }),
        [],
      );
      return (
        <LazyBoundary label="Terminal">
          <FeatureTerminalTabChunk ref={attach} {...props} />
        </LazyBoundary>
      );
    },
  ),
);

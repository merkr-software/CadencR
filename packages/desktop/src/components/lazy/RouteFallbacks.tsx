import type { ReactElement } from "react";
import { ErrorComponent, type ErrorComponentProps } from "@tanstack/react-router";
import { LazyFailed, LazyLoading } from "./LazyBoundary";
import { isChunkLoadFailure } from "./lazy-chunk";

/**
 * Shown in place of a page whose chunk (`*.lazy.tsx`) is still loading after
 * the router's pending delay.
 */
export function RoutePending(): ReactElement {
  return <LazyLoading label="page" variant="panel" />;
}

/** A page whose chunk failed to load offers a reload; any other error renders as before. */
export function RouteError(props: ErrorComponentProps): ReactElement {
  const { error } = props;
  if (isChunkLoadFailure(error)) {
    return <LazyFailed label="this page" variant="panel" />;
  }
  return <ErrorComponent {...props} />;
}

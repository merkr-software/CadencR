import type { ReactElement } from "react";
import { ErrorComponent, type ErrorComponentProps } from "@tanstack/react-router";
import { useUiTranslation } from "@/lib/i18n/ui";
import { LazyFailed, LazyLoading } from "./LazyBoundary";
import { isChunkLoadFailure } from "./lazy-chunk";

/**
 * Shown in place of a page whose chunk (`*.lazy.tsx`) is still loading after
 * the router's pending delay.
 */
export function RoutePending(): ReactElement {
  const { t } = useUiTranslation();
  return <LazyLoading label={t("lazy.labels.page", "page")} variant="panel" />;
}

/** A page whose chunk failed to load offers a reload; any other error renders as before. */
export function RouteError(props: ErrorComponentProps): ReactElement {
  const { t } = useUiTranslation();
  const { error } = props;
  if (isChunkLoadFailure(error)) {
    return <LazyFailed label={t("lazy.labels.thisPage", "this page")} variant="panel" />;
  }
  return <ErrorComponent {...props} />;
}

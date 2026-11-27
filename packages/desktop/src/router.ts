import { hydrateBeforeNavigation } from "./lib/conversation-preload";
import { diagnosticRoute, recordDiagnosticEvent } from "./lib/renderer-diagnostics";
import { createRouter, createHashHistory } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { RouteError, RoutePending } from "./components/lazy/RouteFallbacks";

const hashHistory = createHashHistory();

export const router = createRouter({
  routeTree,
  history: hashHistory,
  // Settings, Schedules, Marketplace and the agents grid are lazy routes: the
  // router loads their chunk before showing them, and past its pending delay
  // shows a spinner in their place. A link's hover or touch (after the
  // router's short preload delay) fetches its page's chunk ahead of the click.
  // No route has a loader: a preload runs the cheap `beforeLoad` checks and
  // imports a chunk at most once, so a sweep over many links costs nothing more.
  defaultPreload: "intent",
  defaultPendingComponent: RoutePending,
  defaultErrorComponent: RouteError,
});

// Before React renders the destination: a conversation whose data was
// preloaded goes into the stores now, so its workspace mounts with content.
router.subscribe("onBeforeNavigate", ({ toLocation }) => hydrateBeforeNavigation(toLocation));

router.subscribe("onResolved", ({ toLocation }) => {
  recordDiagnosticEvent("navigation", { route: diagnosticRoute(toLocation.pathname) });
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

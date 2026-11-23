import { hydrateBeforeNavigation } from "./lib/conversation-preload";
import { diagnosticRoute, recordDiagnosticEvent } from "./lib/renderer-diagnostics";
import { createRouter, createHashHistory } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

const hashHistory = createHashHistory();

export const router = createRouter({
  routeTree,
  history: hashHistory,
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

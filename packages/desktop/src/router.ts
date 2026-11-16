import { diagnosticRoute, recordDiagnosticEvent } from "./lib/renderer-diagnostics";
import { createRouter, createHashHistory } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

const hashHistory = createHashHistory();

export const router = createRouter({
  routeTree,
  history: hashHistory,
});

router.subscribe("onResolved", ({ toLocation }) => {
  recordDiagnosticEvent("navigation", { route: diagnosticRoute(toLocation.pathname) });
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

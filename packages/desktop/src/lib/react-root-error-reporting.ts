import type { RootOptions } from "react-dom/client";
import { reportReactBoundaryError } from "./renderer-error-reporting";

export const reactRootErrorHandlers = {
  onCaughtError(error, info) {
    console.error("React caught UI error:", error, info);
    reportReactBoundaryError(error, info.componentStack ?? null);
  },
  onUncaughtError(error, info) {
    console.error("React uncaught UI error:", error, info);
    reportReactBoundaryError(error, info.componentStack ?? null, "react-uncaught");
  },
  onRecoverableError(error, info) {
    console.error("React recovered from UI error:", error, info);
    reportReactBoundaryError(error, info.componentStack ?? null, "react-recoverable");
  },
} satisfies RootOptions;

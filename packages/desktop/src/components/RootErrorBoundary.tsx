import {
  Component,
  useEffect,
  useRef,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
} from "react";
import { AlertTriangleIcon, LayoutGridIcon, MessageSquareIcon } from "lucide-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { readSavedFeature, type SavedFeature } from "@/lib/saved-feature";
import { reportReactBoundaryError } from "@/lib/renderer-error-reporting";
import { ErrorDetailsPanel } from "./ErrorDetailsPanel";

interface RootErrorBoundaryState {
  error: Error | null;
  /**
   * React's component stack for the crash (display names of the component
   * tree at the throw site). Present even in minified production builds, and
   * the only thing that names *which* component looped on a "Maximum update
   * depth exceeded" — so we surface it in the fallback for the user to
   * screenshot (works on desktop and the remote/phone client alike).
   */
  componentStack: string | null;
}

interface RootErrorBoundaryProps {
  children: ReactNode;
}

/**
 * Catches any render/lifecycle error in the route content and offers two
 * one-click recovery paths so the user does not have to restart the desktop
 * shell (the Rust backend — and any running agents — keep working in the
 * background).
 *
 * Mounted around the route `<Outlet />` rather than the whole app so that
 * the sidebar, command palette, and global shortcuts remain usable while
 * the fallback is shown.
 */
export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<RootErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the dev console; the fallback shows the message AND the
    // component stack to the user (the error-handling rule requires
    // user-visible feedback, and the stack is what names the looping
    // component on "Maximum update depth exceeded"). The stack lives only on
    // `ErrorInfo` here — `getDerivedStateFromError` never receives it — so a
    // second setState is the only way to capture it.
    console.error("Unhandled UI error:", error, info);
    const componentStack = info.componentStack ?? null;
    reportReactBoundaryError(error, componentStack);
    this.setState({ componentStack });
  }

  private reset = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <RootErrorFallback
          error={this.state.error}
          componentStack={this.state.componentStack}
          onReset={this.reset}
        />
      );
    }
    return this.props.children;
  }
}

interface RootErrorFallbackProps {
  error: Error;
  componentStack: string | null;
  onReset: () => void;
}

function RootErrorFallback({
  error,
  componentStack,
  onReset,
}: RootErrorFallbackProps): ReactElement {
  const navigate = useNavigate();
  const lastFeature: SavedFeature | null = readSavedFeature();

  // Drop the error state on any navigation away from the crashed route,
  // including sidebar / command-palette nav. Resetting on the initial mount
  // would loop (child rethrows, boundary recatches), so we anchor on the
  // pathname captured when the fallback first appeared.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const erroredAtPathRef = useRef(pathname);
  useEffect(() => {
    if (pathname !== erroredAtPathRef.current) onReset();
  }, [pathname, onReset]);

  const message = error.message || String(error);
  const details = componentStack ? `${message}\n\nComponent stack:${componentStack}` : message;

  const goToAgents = (): void => {
    void navigate({ to: "/agents" });
  };

  const goToLastConversation = (): void => {
    if (!lastFeature) return;
    void navigate({
      to: "/projects/$projectId/features/$featureId",
      params: {
        projectId: String(lastFeature.projectId),
        featureId: String(lastFeature.featureId),
      },
    });
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="flex items-center gap-2 text-amber-500">
        <AlertTriangleIcon className="size-5" />
        <h2 className="text-base font-semibold text-foreground">Something went wrong</h2>
      </div>
      <p className="max-w-md text-center text-sm text-muted-foreground">
        Your agents are still running in the background. Pick a destination below to recover without
        restarting Cadencr.
      </p>
      <ErrorDetailsPanel details={details} />
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={goToAgents}>
          <LayoutGridIcon className="size-4" />
          Open unified agents view
        </Button>
        <Button variant="outline" onClick={goToLastConversation} disabled={lastFeature == null}>
          <MessageSquareIcon className="size-4" />
          {lastFeature == null ? "No recent conversation" : "Open most recent conversation"}
        </Button>
      </div>
    </div>
  );
}

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { reportReactBoundaryError } from "@/lib/renderer-error-reporting";
import { ErrorDetailsPanel } from "./ErrorDetailsPanel";

interface GlobalErrorBoundaryProps {
  children: ReactNode;
}

interface GlobalErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

export class GlobalErrorBoundary extends Component<
  GlobalErrorBoundaryProps,
  GlobalErrorBoundaryState
> {
  state: GlobalErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<GlobalErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? null;
    console.error("Unhandled root UI error:", error, info);
    reportReactBoundaryError(error, componentStack);
    this.setState({ componentStack });
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.message || String(this.state.error);
    const details = this.state.componentStack
      ? `${message}\n\nComponent stack:${this.state.componentStack}`
      : message;

    return (
      <div className="flex h-[var(--app-vh)] flex-col items-center justify-center gap-4 bg-background p-6 text-foreground">
        <div className="flex items-center gap-2 text-amber-500">
          <AlertTriangleIcon className="size-5" />
          <h1 className="text-base font-semibold text-foreground">Cadencr UI crashed</h1>
        </div>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          Your agents may still be running in the background. Reload the UI to reconnect to the
          local service.
        </p>
        <ErrorDetailsPanel details={details} />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={this.reload}>
            <RotateCcwIcon className="size-4" />
            Reload UI
          </Button>
        </div>
      </div>
    );
  }
}

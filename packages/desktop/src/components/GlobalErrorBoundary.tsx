import { UiTrans } from "@/lib/i18n/ui";
import type { DiagnosticContext } from "@/shared/renderer-diagnostics";
import { formatDiagnosticError } from "@/lib/renderer-diagnostics";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { reportReactBoundaryError } from "@/lib/renderer-error-reporting";
import { ErrorDetailsPanel } from "./ErrorDetailsPanel";
import { Toaster } from "@/components/ui/sonner";

interface GlobalErrorBoundaryProps {
  children: ReactNode;
}

interface GlobalErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  diagnostics: DiagnosticContext | null;
}

export class GlobalErrorBoundary extends Component<
  GlobalErrorBoundaryProps,
  GlobalErrorBoundaryState
> {
  state: GlobalErrorBoundaryState = { error: null, componentStack: null, diagnostics: null };

  static getDerivedStateFromError(error: Error): Partial<GlobalErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? null;
    console.error("Unhandled root UI error:", error, info);
    const diagnostics = reportReactBoundaryError(error, componentStack);
    this.setState({ componentStack, diagnostics });
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const details = formatDiagnosticError(
      this.state.error,
      this.state.componentStack,
      this.state.diagnostics,
    );

    return (
      <div className="flex h-[var(--app-vh)] flex-col items-center justify-center gap-4 bg-background p-6 text-foreground">
        <Toaster duration={Infinity} />
        <div className="flex items-center gap-2 text-amber-500">
          <AlertTriangleIcon className="size-5" />
          <h1 className="text-base font-semibold text-foreground">
            <UiTrans i18nKey="shell.errors.crashed" defaults="Cadencr UI crashed" />
          </h1>
        </div>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          <UiTrans
            i18nKey="shell.errors.crashedHint"
            defaults="Your agents may still be running in the background. Reload the UI to reconnect to the local service."
          />
        </p>
        <ErrorDetailsPanel details={details} />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={this.reload}>
            <RotateCcwIcon className="size-4" />
            <UiTrans i18nKey="shell.errors.reload" defaults="Reload UI" />
          </Button>
        </div>
      </div>
    );
  }
}

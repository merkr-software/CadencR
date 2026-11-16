import { ShieldAlertIcon, X } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";

interface ToolPermissionPromptHeaderProps {
  toolName: string;
  onCancel?: () => void;
}

export function ToolPermissionPromptHeader({
  toolName,
  onCancel,
}: ToolPermissionPromptHeaderProps): JSX.Element {
  return (
    <div className="mb-2 flex items-center gap-2 text-xs text-amber-400">
      <ShieldAlertIcon className="size-3.5" />
      <span className="font-medium">Permission Required</span>
      {toolName ? (
        <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground">{toolName}</code>
      ) : null}
      {onCancel && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onCancel}
          aria-label="Dismiss permission request (Esc)"
          title="Dismiss (Esc) - stops the agent"
          className="ml-auto size-5 text-muted-foreground"
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

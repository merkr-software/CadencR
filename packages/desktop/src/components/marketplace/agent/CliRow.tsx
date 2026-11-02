import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import type { ExtensionCliSummary } from "@/api/generated";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/lib/provider-icons";
import {
  actionKey,
  useAgentExtensionActions,
  type AgentExtensionAction,
} from "./AgentExtensionActions";

/** One agent CLI's line on a detail page: what it has, and what can be done in it. */
export function CliRow({
  cli,
  status,
  detail,
  children,
}: {
  cli: ExtensionCliSummary;
  status: React.ReactNode;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 px-4 py-3 last:border-b-0">
      <ProviderIcon providerId={cli.provider_id} alt="" className="size-5 shrink-0 rounded-sm" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">
          {cli.label}
          {cli.version && (
            <span className="ml-1.5 font-mono text-[10.5px] font-normal text-muted-foreground">
              {cli.version}
            </span>
          )}
        </p>
        <div className="text-[11.5px] text-muted-foreground">{status}</div>
        {detail && <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** Runs one CLI change with its own spinner; disabled while that target is busy. */
export function ActionButton({
  action,
  idle,
  busyLabel,
  variant,
  size = "sm",
  className,
  disabled,
}: {
  action: AgentExtensionAction;
  idle: string;
  busyLabel: string;
  variant?: "default" | "outline";
  size?: "sm" | "xs";
  className?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const { run, pending } = useAgentExtensionActions();
  const busy = pending.has(actionKey(action));
  return (
    <Button
      size={size}
      className={className}
      variant={variant}
      disabled={busy || disabled}
      onClick={() => void run(action)}
    >
      {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
      {busy ? busyLabel : idle}
    </Button>
  );
}

/** Removal always asks first: it edits the CLI's own configuration. */
export function RemoveButton({
  action,
  description,
}: {
  action: AgentExtensionAction;
  description: string;
}): React.JSX.Element {
  const { run, pending } = useAgentExtensionActions();
  const [confirming, setConfirming] = useState(false);
  const busy = pending.has(actionKey(action));
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove ${action.label} from ${action.cliLabel}`}
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {busy ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : (
          <Trash2 aria-hidden="true" />
        )}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove ${action.label} from ${action.cliLabel}?`}
        description={description}
        variant="destructive"
        confirmText={busy ? "Removing…" : "Remove"}
        busy={busy}
        onConfirm={() => run(action)}
      />
    </>
  );
}

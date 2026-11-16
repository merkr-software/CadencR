import { useState, type ReactNode } from "react";
import { AlertTriangle, ShieldOff } from "lucide-react";
import { useSetting } from "@/hooks/useSetting";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsCard } from "./SettingsCard";
import { SettingsSubsection } from "./SettingsSubsection";
import { IconTile } from "./IconTile";

/**
 * Per-provider opt-in for an unsafe permission mode (Claude Code's
 * BypassPermissions, Codex's danger-full-access). Flipping ON shows a
 * confirmation dialog; flipping OFF is silent.
 *
 * `variant` controls the wrapper: `"card"` (default) is a standalone
 * red-tinted card; `"subsection"` renders the same content as a danger-tinted
 * `SettingsSubsection` so it can sit inside a provider's card, divided from
 * the rows above it.
 */
export function DangerousModeToggle({
  settingKey,
  title,
  description,
  warningTitle,
  warningBody,
  variant = "card",
}: {
  settingKey: string;
  title: string;
  description: ReactNode;
  warningTitle: string;
  warningBody: ReactNode;
  variant?: "card" | "subsection";
}): ReactNode {
  const { value, setValue, isLoading } = useSetting(settingKey);
  const enabled = value === "true";
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleToggle = (checked: boolean): void => {
    if (checked) {
      setConfirmOpen(true);
      return;
    }
    setValue("false");
  };

  const handleConfirm = (): void => {
    setValue("true");
    setConfirmOpen(false);
  };

  const body = (
    <>
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-start gap-3">
          <IconTile tint="red">
            <ShieldOff className="size-4" aria-hidden />
          </IconTile>
          <div>
            <div className="text-sm font-semibold">{title}</div>
            <p className="mt-0.5 max-w-md text-xs text-muted-foreground leading-snug">
              {description}
            </p>
            <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-[var(--acc-red)]">
              <AlertTriangle className="size-3" aria-hidden />
              Only enable in containers, VMs, or dev sandboxes.
            </div>
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={isLoading}
          aria-label={title}
        />
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[var(--acc-red)]">
              <ShieldOff className="size-4" aria-hidden />
              {warningTitle}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 pt-2 text-foreground">{warningBody}</div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirm}>
              I understand, enable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (variant === "subsection") {
    return (
      <SettingsSubsection className="border-[color-mix(in_oklab,var(--acc-red)_30%,transparent)] bg-[color-mix(in_oklab,var(--acc-red)_6%,transparent)]">
        {body}
      </SettingsSubsection>
    );
  }

  return (
    <SettingsCard tone="danger" padded>
      {body}
    </SettingsCard>
  );
}

import {
  ArrowRight,
  BotIcon,
  CodeIcon,
  GitCompareArrowsIcon,
  GlobeIcon,
  TerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CadencrLogo } from "@/components/CadencrLogo";
import type { OnboardingStepProps } from "../OnboardingOverlay";

/**
 * Final step — a real "you're set up" moment. Congratulates the user, affirms
 * the brand, and drives the single next action (open the workspace). Advancing
 * persists `step = "completed"`, which `OnboardingGate` uses to unmount the
 * overlay so the user lands straight in the workspace.
 */
export function FirstPromptStep({ isPersisting, onAdvance, onBack }: OnboardingStepProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAdvance();
      }}
      className="flex flex-col items-center gap-8 py-4 text-center"
    >
      <div className="flex flex-col items-center gap-5">
        <CadencrLogo className="size-28" />

        <div className="space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--acc-purple)]">
            You&apos;re all set
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Welcome to{" "}
            <span className="font-brand font-extrabold uppercase tracking-widest">Cadencr</span>
          </h1>
          <p className="mx-auto max-w-md text-base leading-relaxed text-muted-foreground">
            Your workspace is configured and ready. Open a feature, type a prompt, and let your
            agent get to work — everything you just set up can be tuned later in Settings.
          </p>
        </div>
      </div>

      <div className="grid w-full max-w-xl grid-cols-5 gap-3">
        <QuickTip icon={<BotIcon className="size-4" />} label="Agent" />
        <QuickTip icon={<TerminalIcon className="size-4" />} label="Terminal" />
        <QuickTip icon={<GitCompareArrowsIcon className="size-4" />} label="Git" />
        <QuickTip icon={<CodeIcon className="size-4" />} label="Editor" />
        <QuickTip icon={<GlobeIcon className="size-4" />} label="Browser" />
      </div>

      <div className="flex w-full max-w-md flex-col items-center gap-3 pt-1">
        <Button
          type="submit"
          onClick={onAdvance}
          disabled={isPersisting}
          className="h-11 w-full text-base"
        >
          Start using Cadencr
          <ArrowRight className="size-4" />
        </Button>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Back
          </button>
        ) : null}
      </div>
    </form>
  );
}

function QuickTip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-3">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}

import type { ReactNode } from "react";
import { AgentVerbositySettings } from "@/components/settings/AgentVerbositySettings";
import { AgentSummaryModeToggle } from "@/components/settings/AgentSummaryModeToggle";
import { NotificationModePicker } from "@/components/settings/NotificationModePicker";
import { McpToggleList } from "@/components/settings/McpToggleList";
import { OnboardingFooter } from "../OnboardingFooter";
import type { OnboardingStepProps } from "../OnboardingOverlay";

/**
 * Step 5 — workspace preferences that apply everywhere. Each control is the
 * exact component the Settings page uses, wired to the same setting keys, so
 * onboarding and Settings never drift. Every field already resolves to the
 * app's default, so a user can Skip and keep all defaults.
 */
export function PreferencesStep({
  isPersisting,
  onAdvance,
  onBack,
  onSkipStep,
}: OnboardingStepProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAdvance();
      }}
      className="flex flex-col gap-6"
    >
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">Tune your workspace</h2>
        <p className="text-sm text-muted-foreground">
          Sensible defaults are already selected — adjust anything you like, or skip and change it
          later in Settings. Changes save automatically.
        </p>
      </header>

      <PreferenceGroup
        title="Agent output"
        description="How much of each agent turn you see in the stream."
      >
        <AgentVerbositySettings />
        <div className="overflow-hidden rounded-[10px] border border-border bg-card">
          <AgentSummaryModeToggle />
        </div>
      </PreferenceGroup>

      <PreferenceGroup
        title="Notifications"
        description="Where agent-finished notifications appear."
      >
        <NotificationModePicker />
      </PreferenceGroup>

      <PreferenceGroup
        title="Agent tools (MCP)"
        description="Built-in tool servers Cadencr exposes to your agents."
      >
        <div className="overflow-hidden rounded-[10px] border border-border bg-card">
          <McpToggleList />
        </div>
      </PreferenceGroup>

      <OnboardingFooter
        primaryLabel="Continue"
        onPrimary={onAdvance}
        primaryDisabled={isPersisting}
        onBack={onBack}
        onSkipStep={onSkipStep}
      />
    </form>
  );
}

function PreferenceGroup({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

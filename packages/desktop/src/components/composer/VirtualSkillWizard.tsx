import {
  memo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { Check, ChevronDown, FolderIcon, GitBranchIcon, GitForkIcon, Loader2 } from "lucide-react";
import type { SkillWorktree, VirtualSkillPayload } from "@/api/generated";
import { CadencrLogo } from "@/components/CadencrLogo";
import { KbdShortcut, ResolvedShortcutHint } from "@/components/KbdShortcut";
import type { PromptEditorHandle } from "@/components/prompt-editor/PromptEditor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";
import { virtualSkillFlags, type VirtualSkillConfig } from "@/lib/virtual-skill-config";
import { VirtualSkillAgentControls } from "./VirtualSkillAgentControls";
import { SkillWizardSection, useSkillWizardFocus, useWizardShortcut } from "./useSkillWizardFocus";
import type { VirtualSkillWizardState } from "./useVirtualSkillWizard";

const TRAY = "mx-2 rounded-t-lg border border-b-0 border-border/70 bg-muted/30";

/**
 * Stacked on the composer card's top edge while the draft invokes a
 * configurable `/cadencr:*` skill: what the skill does, in full, and the
 * composer's own instruments to configure the sessions it spawns. The choices
 * are written into the prompt as flags when it is sent.
 */
export const VirtualSkillWizard = memo(function VirtualSkillWizard({
  state,
  editorRef,
  shortcutsEnabled,
}: {
  state: VirtualSkillWizardState;
  /** The prompt the wizard hands the keys back to. */
  editorRef: RefObject<PromptEditorHandle | null>;
  shortcutsEnabled: boolean;
}): ReactElement | null {
  if (state.status === "none") return null;
  if (state.status === "loading") {
    return (
      <div
        className={cn(TRAY, "flex h-8 items-center gap-2 px-3 text-[11px] text-muted-foreground")}
        role="status"
      >
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Loading /{state.command}…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <p className={cn(TRAY, "px-3 py-2 text-[11px] text-destructive")} role="alert">
        {apiErrorMessage(state.error, `Could not load the options of /${state.command}.`)}
      </p>
    );
  }
  return (
    <ReadyWizard
      skill={state.skill}
      config={state.config}
      setConfig={state.setConfig}
      editorRef={editorRef}
      shortcutsEnabled={shortcutsEnabled}
    />
  );
});

function ReadyWizard({
  skill,
  config,
  setConfig,
  editorRef,
  shortcutsEnabled,
}: {
  skill: VirtualSkillPayload;
  config: VirtualSkillConfig;
  setConfig: (config: VirtualSkillConfig) => void;
  editorRef: RefObject<PromptEditorHandle | null>;
  shortcutsEnabled: boolean;
}): ReactElement {
  const focus = useSkillWizardFocus({ editorRef, shortcutsEnabled });
  // The composer's shortcuts set the spawned session only while it has focus.
  const keysHere = shortcutsEnabled && focus.active;
  const worktrees = skill.parameters.worktrees;
  const flags = virtualSkillFlags(skill, config);
  return (
    <SkillWizardSection.Provider value={focus.section}>
      <section
        {...focus.sectionProps}
        data-virtual-skill-wizard
        data-keys-active={focus.active || undefined}
        aria-label={`Configure /${skill.command}`}
        // The focused-card border: one of wizard and card owns the keys at a time.
        className={cn(
          TRAY,
          "@container flex flex-col gap-2 px-2.5 pt-2.5 pb-2.5 transition-colors duration-150",
          focus.active && "border-[var(--composer-focus-border)] bg-muted/45",
        )}
      >
        {/* 1 · How it reads when typed: the command, then the slot to fill. */}
        <header className="flex min-w-0 items-center gap-2">
          <CadencrLogo className="size-4 shrink-0" />
          <span className="shrink-0 font-mono text-[12.5px] font-semibold text-foreground">
            /{skill.command}
          </span>
          {skill.argument_hint ? (
            <span
              className="min-w-0 truncate rounded border border-dashed border-border px-1.5 py-px text-[11.5px] text-muted-foreground"
              title="What to type after the command"
            >
              {skill.argument_hint}
            </span>
          ) : null}
          <span className="flex-1" />
          <KeysOwner active={focus.active} />
        </header>
        {/* 2 · What it does: its gist leading, the rest folded to two lines. */}
        <SkillDescription gist={skill.description} details={skill.details} />
        {/* 3 · How it runs: the instruments, on their own surface, against the card. */}
        <div
          role="group"
          aria-label="Spawned session"
          // A composer zone: its groups get the composer's hairlines between them.
          data-composer-zone
          className="flex min-w-0 flex-wrap items-center gap-0.5 rounded-md border border-border/60 bg-background/70 py-0.5 pr-1 pl-2.5"
        >
          <span className="mr-1 text-[11px] font-medium text-muted-foreground">
            Spawned session
          </span>
          {skill.parameters.agent && (
            <VirtualSkillAgentControls
              config={config}
              onChange={setConfig}
              shortcutsActive={keysHere}
            />
          )}
          {worktrees.length > 1 && (
            <span data-composer-group className="flex items-center">
              <SkillWorktreeControl
                options={worktrees}
                value={config.worktree ?? worktrees[0]}
                onChange={(worktree) => setConfig({ ...config, worktree })}
                shortcutsActive={keysHere}
              />
            </span>
          )}
          {flags.length > 0 && (
            // What Send writes after the command, counted; the exact flags on hover.
            <span
              className="ml-auto shrink-0 pr-1.5 font-mono text-[11px] text-muted-foreground"
              title={`Added after the command: ${flags.join(" ")}`}
            >
              +{flags.length} {flags.length === 1 ? "flag" : "flags"}
              <span className="sr-only">: {flags.join(" ")}</span>
            </span>
          )}
        </div>
      </section>
    </SkillWizardSection.Provider>
  );
}

/**
 * Who the composer's keys drive right now. From the prompt: the shortcut that
 * enters the wizard. In the wizard: that its keys set the spawned session, and
 * how to get back.
 */
function KeysOwner({ active }: { active: boolean }): ReactElement {
  if (!active) {
    return (
      // A key hint means nothing on a touch screen.
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground pointer-coarse:hidden">
        <ResolvedShortcutHint shortcutId="agent-skill-wizard" />
        <span className="@max-[30rem]:hidden">Configure</span>
      </span>
    );
  }
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"
      role="status"
    >
      <span className="text-foreground/85 @max-[30rem]:hidden">
        Shortcuts set the spawned session
      </span>
      <KbdShortcut keys={["Esc"]} variant="hint" />
      <span>Prompt</span>
    </span>
  );
}

/**
 * The skill's description: its one-line gist, then the full text folded to two
 * lines. The fold only offers itself when the text actually overflows.
 */
function SkillDescription({ gist, details }: { gist: string; details: string }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || expanded) return undefined;
    const measure = (): void => setOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [details, expanded]);
  return (
    <div className="flex flex-col items-start gap-0.5 pl-6">
      <p
        ref={ref}
        id={id}
        className={cn(
          "max-w-[80ch] text-xs leading-[1.6] text-muted-foreground",
          !expanded && "line-clamp-2",
        )}
      >
        <span className="font-medium text-foreground/90">{asSentence(gist)}</span> {details}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          className="rounded-sm text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show full description"}
        </button>
      )}
    </div>
  );
}

/** The skill's one-line description, punctuated to lead a paragraph. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const WORKTREE_OPTIONS: Record<
  SkillWorktree,
  { label: string; description: string; icon: typeof GitBranchIcon }
> = {
  same: {
    label: "Same worktree",
    description: "Works in this conversation's worktree and sees its uncommitted changes.",
    icon: GitBranchIcon,
  },
  new: {
    label: "New worktree",
    description: "A fresh worktree on a new branch from the current one.",
    icon: GitForkIcon,
  },
  project: {
    label: "Project folder",
    description: "The project's main checkout, without a worktree.",
    icon: FolderIcon,
  },
};

function SkillWorktreeControl({
  options,
  value,
  onChange,
  shortcutsActive,
}: {
  options: readonly SkillWorktree[];
  value: SkillWorktree;
  onChange: (worktree: SkillWorktree) => void;
  shortcutsActive: boolean;
}): ReactElement {
  const active = WORKTREE_OPTIONS[value];
  // The composer's worktree chord, cycling in place like the session's picker.
  useWizardShortcut(
    "agent-worktree-mode",
    () => onChange(options[(options.indexOf(value) + 1) % options.length]),
    shortcutsActive,
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="composer-instrument min-w-0 gap-1.5 text-foreground"
          aria-label={`Where it works: ${active.label}`}
        >
          <active.icon className="size-3.5 shrink-0 text-[var(--chip-worktree-fg)]" aria-hidden />
          <span className="truncate">{active.label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-50" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72 p-1">
        <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">
          Where it works
        </DropdownMenuLabel>
        {options.map((option, index) => {
          const entry = WORKTREE_OPTIONS[option];
          return (
            <DropdownMenuItem
              key={option}
              onSelect={() => onChange(option)}
              className="items-start gap-2.5 py-2"
            >
              <entry.icon
                className="mt-0.5 size-3.5 shrink-0 text-[var(--chip-worktree-fg)]"
                aria-hidden
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] font-medium">
                  {entry.label}
                  {index === 0 && (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      Default
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{entry.description}</span>
              </span>
              {option === value && <Check className="mt-0.5 size-3.5 shrink-0" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

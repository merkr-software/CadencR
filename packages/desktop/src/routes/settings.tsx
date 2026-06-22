import { useEffect, useRef } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useShortcut } from "@/hooks/useShortcut";
import {
  ArrowLeft,
  Bell,
  BrainCircuit,
  ChevronRight,
  Code2,
  Files,
  GitMerge,
  Globe,
  History,
  Info,
  Keyboard,
  MonitorCog,
  Network,
  Palette,
  Plug,
  Save,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ModelSelector } from "@/components/ModelSelector";
import { NotificationsSection } from "@/components/settings/NotificationsSection";
import { BrowserSection } from "@/components/settings/BrowserSection";
import { McpSection } from "@/components/settings/McpSection";
import { InterfaceSection } from "@/components/settings/InterfaceSection";
import { GitSection } from "@/components/settings/GitSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { AboutSection } from "@/components/settings/AboutSection";
import { AgentVerbositySettings } from "@/components/settings/AgentVerbositySettings";
import { ThemeSelector } from "@/components/settings/ThemeSelector";
import { FileTreeIconSetSelector } from "@/components/settings/FileTreeIconSetSelector";
import { LspServerList } from "@/components/settings/LspServerList";
import { AnimationsToggle } from "@/components/settings/AnimationsToggle";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { WorkspaceJsonSettings } from "@/components/settings/SettingsJsonControls";
import { SettingsSubsection } from "@/components/settings/SettingsSubsection";
import { SettingsRow } from "@/components/settings/SettingsRow";
import { SettingsSwitchRow } from "@/components/settings/SettingsSwitchRow";
import {
  SettingsNavSidebar,
  type SettingsNavGroup,
} from "@/components/settings/SettingsNavSidebar";
import { IconTile } from "@/components/settings/IconTile";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { APP_VERSION } from "@/lib/app-version";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>): { section?: string } => {
    if (typeof search.section === "string") return { section: search.section };
    return {};
  },
});

const NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: "General",
    items: [
      {
        id: "appearance",
        label: "Appearance",
        icon: <Palette className="size-4" />,
      },
      { id: "editor", label: "Editor", icon: <Code2 className="size-4" /> },
      {
        id: "interface",
        label: "Interface & Zoom",
        icon: <MonitorCog className="size-4" />,
      },
      {
        id: "notifications",
        label: "Notifications",
        icon: <Bell className="size-4" />,
      },
      {
        id: "browser",
        label: "Browser",
        icon: <Globe className="size-4" />,
      },
    ],
  },
  {
    label: "MCP",
    items: [
      {
        id: "mcp",
        label: "MCP",
        icon: <Network className="size-4" />,
      },
    ],
  },
  {
    label: "Agents",
    items: [
      {
        id: "runtime",
        label: "Runtime & Models",
        icon: <BrainCircuit className="size-4" />,
      },
    ],
  },
  {
    label: "Source Control",
    items: [{ id: "git", label: "Git", icon: <GitMerge className="size-4" /> }],
  },
  {
    label: "Providers",
    items: [
      {
        id: "providers",
        label: "CLI Providers",
        icon: <Plug className="size-4" />,
      },
    ],
  },
  {
    label: "About",
    items: [
      {
        id: "about",
        label: "About Cadencr",
        icon: <Info className="size-4" />,
      },
    ],
  },
];

function SettingsPage() {
  const { section } = Route.useSearch();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement | null>(null);

  const goBack = () => {
    void navigate({ to: "/" });
  };

  // Escape leaves the settings page. `useShortcut` defaults to firing from
  // inside form controls so users don't have to defocus first.
  useShortcut("settings-back", (e) => {
    e.preventDefault();
    goBack();
  });

  // Honor `?section=...` deep links — scroll once the layout has painted.
  useEffect(() => {
    if (!section) return;
    const target = document.getElementById(section);
    const main = mainRef.current;
    if (!target || !main) return;
    main.scrollTo({ top: target.offsetTop - 16 });
  }, [section]);

  return (
    <div className="flex h-full bg-background text-foreground">
      <SettingsNavSidebar
        groups={NAV_GROUPS}
        scrollRef={mainRef}
        header={
          <div className="flex items-center gap-2">
            <div className="grid size-7 place-items-center rounded-md bg-primary text-[var(--primary-foreground)]">
              <Settings2 className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold">Settings</div>
              <div className="truncate text-[11px] text-muted-foreground">
                Cadencr v{APP_VERSION}
              </div>
            </div>
          </div>
        }
        footer={
          <div className="flex items-center justify-between gap-2">
            <span>Changes save automatically.</span>
            <button
              type="button"
              onClick={goBack}
              title="Back to workspace (Esc)"
              className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="size-3" />
              Esc
            </button>
          </div>
        }
      />

      <main ref={mainRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] space-y-6 px-4 py-6 md:px-10 md:py-8">
          <header className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Breadcrumbs />
              <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure how Cadencr looks, runs, and orchestrates agents.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={goBack}
              className="shrink-0 gap-1.5"
              title="Back to workspace (Esc)"
            >
              <ArrowLeft className="size-3.5" />
              Back
            </Button>
          </header>

          <SettingsCard padded>
            <WorkspaceJsonSettings />
          </SettingsCard>

          <AppearanceSection />
          <EditorSection />
          <InterfaceSection />
          <NotificationsSection />
          <BrowserSection />
          <McpSection />
          <RuntimeSection />
          <GitSection />
          <ProvidersSection />
          <AboutSection />

          <div className="h-12" />
        </div>
      </main>
    </div>
  );
}

function Breadcrumbs(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Cadencr</span>
      <ChevronRight className="size-3" />
      <span>Settings</span>
    </div>
  );
}

/* ─── Appearance ─────────────────────────────────────────────────────── */

function AppearanceSection(): React.JSX.Element {
  return (
    <SettingsSection id="appearance" title="Appearance" subtitle="Theme · Animations · Verbosity">
      <SettingsCard>
        <SettingsSubsection padded={false}>
          <ThemeSelector />
          <AnimationsToggle divided />
        </SettingsSubsection>
        <SettingsSubsection
          title="Agent output verbosity"
          description="Control how much of each agent turn stays expanded in the stream. Switching modes does not affect what the agent does — only how its output is rendered."
        >
          <AgentVerbositySettings />
        </SettingsSubsection>
      </SettingsCard>
    </SettingsSection>
  );
}

/* ─── Editor ─────────────────────────────────────────────────────────── */

function EditorSection(): React.JSX.Element {
  const vimMode = useDebouncedSetting("editor_vim_mode");
  const autoSave = useDebouncedSetting("editor_auto_save");
  const gitBlame = useDebouncedSetting("editor_git_blame");
  const maxTabs = useDebouncedSetting("editor_max_tabs");

  const isVimEnabled = (vimMode.value ?? "false") === "true";
  const isAutoSaveEnabled = (autoSave.value ?? "false") === "true";
  const isGitBlameEnabled = (gitBlame.value ?? "false") === "true";
  const maxTabsValue = maxTabs.value ?? "10";
  const isLimited = maxTabsValue !== "0";
  const maxTabsNum = isLimited ? parseInt(maxTabsValue, 10) || 10 : 10;

  const setMaxTabsNum = (n: number) => {
    const clamped = Math.max(1, Math.min(50, n));
    maxTabs.setValue(String(clamped));
  };

  return (
    <SettingsSection id="editor" title="Editor" subtitle="CodeMirror · File tree">
      <SettingsCard>
        <SettingsSubsection
          title="File tree icons"
          description="Controls the icon density of the editor's file tree. Affects every project."
        >
          <FileTreeIconSetSelector />
        </SettingsSubsection>
        <SettingsSubsection
          title="Language servers"
          description="Cmd-click and F12 jump-to-definition use these. Servers launch on demand the first time you open a matching file."
        >
          <LspServerList />
        </SettingsSubsection>
        <SettingsSubsection padded={false}>
          <SettingsSwitchRow
            icon={<Keyboard className="size-4" />}
            iconTint="cyan"
            label="Vim motions"
            description="Modal editing in the built-in code editor."
            checked={isVimEnabled}
            onCheckedChange={(checked) => vimMode.setValue(checked ? "true" : "false")}
          />
          <SettingsSwitchRow
            icon={<Save className="size-4" />}
            iconTint="green"
            label="Auto-save"
            description="Automatically save files after a short delay."
            checked={isAutoSaveEnabled}
            onCheckedChange={(checked) => autoSave.setValue(checked ? "true" : "false")}
            divided
          />
          <SettingsSwitchRow
            icon={<History className="size-4" />}
            iconTint="orange"
            label="Git blame"
            description="Show blame annotation on the current line."
            checked={isGitBlameEnabled}
            onCheckedChange={(checked) => gitBlame.setValue(checked ? "true" : "false")}
            divided
          />
          <SettingsRow
            divided
            align="start"
            icon={
              <IconTile tint="pink">
                <Files className="size-4" />
              </IconTile>
            }
            label="Max open tabs"
            description="Older tabs are closed once you exceed the cap. Disable to keep them all."
            control={
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMaxTabsNum(maxTabsNum - 1)}
                  disabled={!isLimited}
                  className="grid size-7 place-items-center rounded-md border border-border bg-card text-sm transition-colors hover:bg-accent disabled:opacity-40"
                  aria-label="Decrease max tabs"
                >
                  −
                </button>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  disabled={!isLimited}
                  value={maxTabsNum}
                  onChange={(e) => setMaxTabsNum(parseInt(e.target.value, 10) || 1)}
                  className="h-7 w-14 text-center disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setMaxTabsNum(maxTabsNum + 1)}
                  disabled={!isLimited}
                  className="grid size-7 place-items-center rounded-md border border-border bg-card text-sm transition-colors hover:bg-accent disabled:opacity-40"
                  aria-label="Increase max tabs"
                >
                  +
                </button>
                <label
                  htmlFor="max-tabs-unlimited"
                  className="ml-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  Unlimited
                  <Switch
                    id="max-tabs-unlimited"
                    size="sm"
                    checked={!isLimited}
                    onCheckedChange={(checked) => maxTabs.setValue(checked ? "0" : "10")}
                  />
                </label>
              </div>
            }
          />
        </SettingsSubsection>
      </SettingsCard>
    </SettingsSection>
  );
}

/* ─── Runtime & Models ───────────────────────────────────────────────── */

function RuntimeSection(): React.JSX.Element {
  return (
    <SettingsSection id="runtime" title="Runtime & Models" subtitle="Per-agent provider & model">
      <SettingsCard>
        <ModelSelector level="global" />
      </SettingsCard>
    </SettingsSection>
  );
}

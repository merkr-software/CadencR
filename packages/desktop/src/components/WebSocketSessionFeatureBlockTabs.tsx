import { useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useMemo, useRef, type ReactElement } from "react";
import {
  CodeIcon,
  FileTextIcon,
  GitCompareArrowsIcon,
  GlobeIcon,
  TerminalIcon,
} from "lucide-react";
import { AgentBrowserActivityDot } from "@/components/feature-layout/AgentBrowserActivityDot";
import { GitBadge, GitBarBadge } from "@/components/feature-layout/GitBadge";
import {
  OpenDiffInEditorProvider,
  type OpenDiffInEditor,
} from "@/components/diff/OpenDiffInEditorContext";
import type { FeatureTabDef, FeatureTabs } from "@/components/feature-layout/types";
import {
  claudeProfileForPrompt,
  type useSessionControls,
  type useSessionFeatureData,
  type useSessionRefs,
} from "@/components/WebSocketSessionFeatureBlockHooks";
import type { NonAgentTabReadiness } from "@/components/useAgentFirstNonAgentWork";
import { usePluginTabDefs, type PluginTabDefs } from "@/components/plugin-tabs/usePluginTabDefs";
import { LazyBoundary } from "@/components/lazy/LazyBoundary";
import { LazyFeatureTerminalTab } from "@/components/LazyFeatureTerminalTab";
import { lazyChunk } from "@/components/lazy/lazy-chunk";
import { useAgentTab } from "./WebSocketSessionAgentTab";

// Every side tab's body is its own chunk: a conversation's first paint shows
// only the agent, and the tabs mount a few frames later (`tabReady`). The
// terminal's is in `LazyFeatureTerminalTab`, which keeps an early `activate`.
const FeatureGitTab = lazyChunk(() =>
  import("@/components/FeatureGitTab").then((module) => module.FeatureGitTab),
);
const FeatureEditorTab = lazyChunk(() =>
  import("@/components/editor/FeatureEditorTab").then((module) => module.default),
);
const FeaturePreviewTab = lazyChunk(() =>
  import("@/components/document-preview/FeaturePreviewTab").then(
    (module) => module.FeaturePreviewTab,
  ),
);
const BrowserWorkspaceTab = lazyChunk(() =>
  import("@/components/BrowserWorkspaceTab").then((module) => module.BrowserWorkspaceTab),
);

export interface UseSessionTabsArgs {
  sessionId: string;
  featureId: number;
  // Scope that owns this block's layout + browser tabs. Equals `featureId` on
  // the feature route, but a distinct per-card id in the unified grid, so each
  // card's Browser stays isolated.
  layoutFeatureId: number;
  projectId: number;
  data: ReturnType<typeof useSessionFeatureData>;
  controls: ReturnType<typeof useSessionControls>;
  refs: ReturnType<typeof useSessionRefs>;
  agentVisible: boolean;
  /** Per-kind readiness; tabs reveal in priority order after the agent paints. */
  tabReady: NonAgentTabReadiness;
  /**
   * Custom tabs (placed, or shown in a built-in's place) open and close with
   * the side tabs' gate, all at once: no stagger.
   */
  pluginTabsReady: boolean;
  hotkeysEnabled: boolean;
  sendFromGitTab: (message: string) => void;
  /** Opener for file references clicked inside the agent conversation. */
  openAgentFileInEditor: OpenDiffInEditor;
  /**
   * Offer the project's custom tabs (`plugin:<id>`). Only the feature route:
   * an embedded unified-grid card shows built-ins only.
   */
  pluginTabsEnabled: boolean;
  /**
   * Paint the transcript's tail in the workspace's first commit. Only the
   * feature route: a grid of embedded cards mounts many transcripts at once.
   */
  openingPreview: boolean;
}

export function useSessionTabs(args: UseSessionTabsArgs): FeatureTabs {
  const agentTab = useAgentFileLinksTab(useAgentTab(args), args.openAgentFileInEditor);
  const terminalTab = useTerminalTab(args);
  const gitTab = useGitTab(args);
  const editorTab = useEditorTab(args);
  const browserTab = useBrowserTab(args);
  const previewTab = usePreviewTab(args);
  const { plugin, replacements } = useSessionPluginTabs(args);
  return useMemo(
    () => ({
      agent: agentTab,
      terminal: replaced(terminalTab, replacements.terminal),
      git: replaced(gitTab, replacements.git),
      editor: replaced(editorTab, replacements.editor),
      browser: browserTab,
      preview: replaced(previewTab, replacements.preview),
      ...plugin,
    }),
    [agentTab, browserTab, editorTab, gitTab, plugin, previewTab, replacements, terminalTab],
  );
}

/**
 * A custom tab shown in a built-in's place keeps the built-in's shortcut, so
 * ⌘⇧G still reaches "Git" (docs/CUSTOM_TABS.md §10).
 */
function replaced(builtin: FeatureTabDef, replacement: FeatureTabDef | undefined): FeatureTabDef {
  return replacement ? { ...replacement, shortcutId: builtin.shortcutId } : builtin;
}

function useSessionPluginTabs(args: UseSessionTabsArgs): PluginTabDefs {
  const { featureId, projectId, data, pluginTabsEnabled, pluginTabsReady } = args;
  const defs = usePluginTabDefs({
    featureId,
    projectId,
    contextData: data,
    enabled: pluginTabsEnabled,
  });
  return useMemo(
    () => (pluginTabsReady ? defs : deferredPluginTabs(defs)),
    [defs, pluginTabsReady],
  );
}

/** The same tabs, their content waiting behind the gate (`DeferredTabContent`). */
function deferredPluginTabs({ plugin, replacements }: PluginTabDefs): PluginTabDefs {
  return { plugin: deferredDefs(plugin), replacements: deferredDefs(replacements) };
}

function deferredDefs<K extends string>(
  defs: Partial<Record<K, FeatureTabDef>>,
): Partial<Record<K, FeatureTabDef>> {
  const deferred: Partial<Record<K, FeatureTabDef>> = {};
  for (const tab in defs) {
    const def: FeatureTabDef | undefined = defs[tab];
    if (def) deferred[tab] = withDeferredContent(def);
  }
  return deferred;
}

function withDeferredContent(def: FeatureTabDef): FeatureTabDef {
  return { ...def, content: <DeferredTabContent label={def.label} /> };
}

/**
 * Scope the agent conversation's file links (edit blocks, path links) to their
 * own opener, so auto layout can split the Editor in beside the agent while
 * the Git tab's opener keeps switching tabs in place.
 */
function useAgentFileLinksTab(tab: FeatureTabDef, openFile: OpenDiffInEditor): FeatureTabDef {
  return useMemo(
    () => ({
      ...tab,
      content: (
        <OpenDiffInEditorProvider onOpenFileInEditor={openFile}>
          {tab.content}
        </OpenDiffInEditorProvider>
      ),
    }),
    [openFile, tab],
  );
}

function useTerminalTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, projectId, refs } = args;
  const terminalReady = args.tabReady.terminal;
  const { t } = useUiTranslation();
  const label = t("conversation.webSocketSessionFeatureBlockTabs.terminalTab", "Terminal");
  return useMemo(
    () => ({
      label,
      Icon: TerminalIcon,
      shortcutId: "pane-terminal",
      content: terminalReady ? (
        <LazyFeatureTerminalTab ref={refs.terminal} featureId={featureId} projectId={projectId} />
      ) : (
        <DeferredTabContent label={label} />
      ),
    }),
    [label, featureId, terminalReady, projectId, refs.terminal],
  );
}

function useGitTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, projectId, data, sendFromGitTab } = args;
  const gitReady = args.tabReady.git;
  // The live session controls replace `sendFromGitTab` throughout streaming.
  // Keep the tab prop stable while always dispatching through the latest one;
  // otherwise every agent block rebuilds the memoized Git panel.
  const sendFromGitTabRef = useRef(sendFromGitTab);
  sendFromGitTabRef.current = sendFromGitTab;
  const handleSendComments = useCallback(
    (message: string): void => sendFromGitTabRef.current(message),
    [],
  );
  const { t } = useUiTranslation();
  const label = t("conversation.webSocketSessionFeatureBlockTabs.gitTab", "Git");
  return useMemo(
    () => ({
      label,
      Icon: GitCompareArrowsIcon,
      shortcutId: "pane-git",
      badge: <GitBadge featureId={featureId} gitBranch={data.gitBranch} />,
      barBadge: <GitBarBadge featureId={featureId} />,
      content: gitReady ? (
        <LazyBoundary label={label}>
          <FeatureGitTab
            featureId={featureId}
            projectId={projectId}
            diffMode="worktree"
            onSendComments={handleSendComments}
          />
        </LazyBoundary>
      ) : (
        <DeferredTabContent label={label} />
      ),
    }),
    [label, data.gitBranch, featureId, gitReady, handleSendComments, projectId],
  );
}

function useBrowserTab(args: UseSessionTabsArgs): FeatureTabDef {
  // Scope the Browser by the real featureId (not layoutFeatureId): the agent's
  // MCP is pinned to featureId, so its tabs are created in that scope. Using the
  // same id here is what makes agent-opened tabs appear in this panel.
  const { controls, featureId } = args;
  const browserReady = args.tabReady.browser;
  const sendContext = useCallback(
    (message: string, images?: Array<{ base64: string; mimeType: string }>): void =>
      controls.ws.sendPrompt(message, {
        attachments: images?.map((image, index) => ({
          base64: image.base64,
          mimeType: image.mimeType,
          fileName: images.length > 1 ? `browser-context-${index + 1}.png` : "browser-context.png",
          kind: "image" as const,
        })),
        claudeProfile: claudeProfileForPrompt(controls),
      }),
    [controls],
  );
  const { t } = useUiTranslation();
  const label = t("conversation.webSocketSessionFeatureBlockTabs.browserTab", "Browser");
  return useMemo(
    () => ({
      label,
      Icon: GlobeIcon,
      shortcutId: "pane-browser",
      badge: <AgentBrowserActivityDot featureId={featureId} />,
      content: browserReady ? (
        <LazyBoundary label={label}>
          <BrowserWorkspaceTab scopeId={featureId} onSendContext={sendContext} />
        </LazyBoundary>
      ) : (
        <DeferredTabContent label={label} />
      ),
    }),
    [label, featureId, browserReady, sendContext],
  );
}

function usePreviewTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, projectId } = args;
  const previewReady = args.tabReady.preview;
  const { t } = useUiTranslation();
  const label = t("conversation.webSocketSessionFeatureBlockTabs.previewTab", "Preview");
  return useMemo(
    () => ({
      label,
      Icon: FileTextIcon,
      content: previewReady ? (
        <LazyBoundary label={label}>
          <FeaturePreviewTab featureId={featureId} projectId={projectId} />
        </LazyBoundary>
      ) : (
        <DeferredTabContent label={label} />
      ),
    }),
    [label, featureId, previewReady, projectId],
  );
}

function useEditorTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, projectId, data, refs } = args;
  const editorReady = args.tabReady.editor;
  const projectPathOrCwd = data.effectiveCwd ?? data.projectPath;
  const { t } = useUiTranslation();
  const label = t("conversation.webSocketSessionFeatureBlockTabs.editorTab", "Editor");
  return useMemo(
    () => ({
      label,
      Icon: CodeIcon,
      shortcutId: "pane-editor",
      content: !editorReady ? (
        <DeferredTabContent label={label} />
      ) : projectPathOrCwd ? (
        <LazyBoundary label={label}>
          <FeatureEditorTab
            ref={refs.editor}
            featureId={featureId}
            projectId={projectId}
            projectPath={projectPathOrCwd}
          />
        </LazyBoundary>
      ) : null,
    }),
    [label, featureId, editorReady, projectId, projectPathOrCwd, refs.editor],
  );
}

/**
 * A side panel waiting for its turn to mount, a few frames behind the
 * conversation (`useStaggeredTabReadiness`). Empty on purpose: it is on screen
 * for less time than a message would take to read.
 */
function DeferredTabContent({ label }: { label: string }): ReactElement {
  return <div className="h-full" data-deferred-tab={label} aria-busy="true" />;
}

import { lazy, Suspense, useCallback, useMemo, useRef, type ReactElement } from "react";
import { CodeIcon, GitCompareArrowsIcon, GlobeIcon, TerminalIcon } from "lucide-react";
import { FeatureGitTab } from "@/components/FeatureGitTab";
import { FeatureTerminalTab } from "@/components/FeatureTerminalTab";
import { GitBadge } from "@/components/feature-layout/GitBadge";
import type { FeatureTabDef, FeatureTabs } from "@/components/feature-layout/types";
import {
  claudeProfileForPrompt,
  type useSessionControls,
  type useSessionFeatureData,
  type useSessionRefs,
} from "@/components/WebSocketSessionFeatureBlockHooks";
import type { NonAgentTabReadiness } from "@/components/useAgentFirstNonAgentWork";
import { useAgentTab } from "./WebSocketSessionAgentTab";
const FeatureEditorTab = lazy(() => import("@/components/editor/FeatureEditorTab"));
const BrowserWorkspaceTab = lazy(() =>
  import("@/components/BrowserWorkspaceTab").then((module) => ({
    default: module.BrowserWorkspaceTab,
  })),
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
  hotkeysEnabled: boolean;
  sendFromGitTab: (message: string) => void;
}

export function useSessionTabs(args: UseSessionTabsArgs): FeatureTabs {
  const agentTab = useAgentTab(args);
  const terminalTab = useTerminalTab(args);
  const gitTab = useGitTab(args);
  const editorTab = useEditorTab(args);
  const browserTab = useBrowserTab(args);
  return useMemo(
    () => ({
      agent: agentTab,
      terminal: terminalTab,
      git: gitTab,
      editor: editorTab,
      browser: browserTab,
    }),
    [agentTab, browserTab, editorTab, gitTab, terminalTab],
  );
}

function useTerminalTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, projectId, refs } = args;
  const terminalReady = args.tabReady.terminal;
  return useMemo(
    () => ({
      label: "Terminal",
      Icon: TerminalIcon,
      shortcut: ["cmd", "shift", "T"],
      content: terminalReady ? (
        <FeatureTerminalTab ref={refs.terminal} featureId={featureId} projectId={projectId} />
      ) : (
        <DeferredTabContent label="Terminal" />
      ),
    }),
    [featureId, terminalReady, projectId, refs.terminal],
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
  return useMemo(
    () => ({
      label: "Git",
      Icon: GitCompareArrowsIcon,
      shortcut: ["cmd", "shift", "G"],
      badge: <GitBadge featureId={featureId} gitBranch={data.gitBranch} />,
      content: gitReady ? (
        <FeatureGitTab
          featureId={featureId}
          projectId={projectId}
          diffMode="worktree"
          onSendComments={handleSendComments}
        />
      ) : (
        <DeferredTabContent label="Git" />
      ),
    }),
    [data.gitBranch, featureId, gitReady, handleSendComments, projectId],
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
  return useMemo(
    () => ({
      label: "Browser",
      Icon: GlobeIcon,
      shortcut: ["cmd", "shift", "B"],
      content: browserReady ? (
        <Suspense fallback={null}>
          <BrowserWorkspaceTab scopeId={featureId} onSendContext={sendContext} />
        </Suspense>
      ) : (
        <DeferredTabContent label="Browser" />
      ),
    }),
    [featureId, browserReady, sendContext],
  );
}

function useEditorTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, projectId, data, refs } = args;
  const editorReady = args.tabReady.editor;
  const projectPathOrCwd = data.effectiveCwd ?? data.projectPath;
  return useMemo(
    () => ({
      label: "Editor",
      Icon: CodeIcon,
      shortcut: ["cmd", "shift", "E"],
      content: !editorReady ? (
        <DeferredTabContent label="Editor" />
      ) : projectPathOrCwd ? (
        <Suspense fallback={null}>
          <FeatureEditorTab
            ref={refs.editor}
            featureId={featureId}
            projectId={projectId}
            projectPath={projectPathOrCwd}
          />
        </Suspense>
      ) : null,
    }),
    [featureId, editorReady, projectId, projectPathOrCwd, refs.editor],
  );
}

function DeferredTabContent({ label }: { label: string }): ReactElement {
  return (
    <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
      Loading {label} after the conversation…
    </div>
  );
}

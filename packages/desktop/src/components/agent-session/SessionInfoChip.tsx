import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { CheckIcon, CopyIcon, InfoIcon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProviderIcon } from "@/lib/provider-icons";
import { getProviderMetadata } from "@/lib/providers";
import { buildResumeCommand } from "@/lib/provider-resume-command";
import { useCatalogProviderMetadata } from "@/hooks/useCatalogProviderMetadata";
import type { ClaudeCodeProfile } from "@/api/agentRuntime";
import { DEFAULT_CLAUDE_PROFILE_NAME, formatClaudeProfileLabel } from "@/lib/claude-profiles";
import { cn } from "@/lib/utils";
import type { McpServerStatus } from "@/stores/ws-session-types";
import { ClaudeProfileCombobox } from "./ClaudeProfileCombobox";
import { McpServersRow } from "./McpServersRow";
import { SyncFromCliRow } from "./SyncFromCliRow";

/** Everything the session details panel shows (the Info chip and the composer menu). */
export interface SessionInfoPanelProps {
  runtimeProvider: string | undefined;
  runtimeSessionId?: string;
  projectPath: string | undefined;
  /** Feature (conversation) id — target of the "Sync from CLI" refresh endpoint. */
  featureId?: number;
  /** WS store key — used to merge the synced events into the live conversation. */
  wsSessionId?: string;
  isRunning: boolean;
  onPause?: () => void;
  claudeProfile?: string;
  claudeProfiles?: ClaudeCodeProfile[];
  claudeProfilesLoading?: boolean;
  claudeProfilesError?: boolean;
  activeClaudeProfile?: string;
  onClaudeProfileChange?: (profile: string) => void;
  showProfileSelector?: boolean;
}

interface SessionInfoChipProps extends SessionInfoPanelProps {
  chipClass: string;
}

const COPY_FEEDBACK_MS = 1500;
const McpServersContext = createContext<McpServerStatus[] | null>(null);

export function SessionInfoMcpServersProvider({
  mcpServers,
  children,
}: {
  mcpServers: McpServerStatus[] | null;
  children: ReactNode;
}): ReactElement {
  return <McpServersContext.Provider value={mcpServers}>{children}</McpServersContext.Provider>;
}

type CopiedField = "id" | "command" | null;

/** Copy the session id / resume command, with a short "copied" acknowledgement. */
function useSessionInfoCopy({
  runtimeProvider,
  runtimeSessionId,
  projectPath,
  isRunning,
  onPause,
}: Pick<
  SessionInfoPanelProps,
  "runtimeProvider" | "runtimeSessionId" | "projectPath" | "isRunning" | "onPause"
>) {
  const [copiedField, setCopiedField] = useState<CopiedField>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const resumeCommand = useCatalogProviderMetadata(runtimeProvider)?.resumeCommand;
  const resume = buildResumeCommand({
    resumeCommand,
    sessionId: runtimeSessionId ?? "",
    cwd: projectPath,
  });

  const copy = async (field: "id" | "command", text: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setCopiedField(field);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
      timeoutRef.current = null;
    }, COPY_FEEDBACK_MS);
  };

  const copySessionId = (): Promise<void> =>
    runtimeSessionId ? copy("id", runtimeSessionId) : Promise.resolve();

  const copyLaunchCommand = async (): Promise<void> => {
    if (!resume.supported) return;
    if (isRunning) onPause?.();
    await copy("command", resume.command);
  };

  return { copiedField, resumeSupported: resume.supported, copySessionId, copyLaunchCommand };
}

/** The session details: provider, MCP servers, profile, ids, resume and sync. */
export function SessionInfoPanel(props: SessionInfoPanelProps): ReactElement {
  const mcpServers = useContext(McpServersContext);
  const copy = useSessionInfoCopy(props);
  return (
    <SessionInfoContent
      runtimeProvider={props.runtimeProvider}
      runtimeSessionId={props.runtimeSessionId}
      featureId={props.featureId}
      wsSessionId={props.wsSessionId}
      mcpServers={mcpServers}
      copiedField={copy.copiedField}
      resumeSupported={copy.resumeSupported}
      isRunning={props.isRunning}
      onCopySessionId={copy.copySessionId}
      onCopyLaunchCommand={copy.copyLaunchCommand}
      claudeProfile={props.claudeProfile}
      claudeProfiles={props.claudeProfiles ?? []}
      claudeProfilesLoading={props.claudeProfilesLoading ?? false}
      claudeProfilesError={props.claudeProfilesError ?? false}
      activeClaudeProfile={props.activeClaudeProfile}
      onClaudeProfileChange={props.onClaudeProfileChange}
      showProfileSelector={props.showProfileSelector ?? false}
    />
  );
}

export function SessionInfoChip({ chipClass, ...panelProps }: SessionInfoChipProps): ReactElement {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Session info"
          className={cn(chipClass, "bg-muted/60 text-foreground/90 hover:bg-muted")}
        >
          <InfoIcon className="size-3" />
          Info
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="flex max-h-[min(70vh,var(--radix-popover-content-available-height))] min-h-0 w-80 flex-col gap-3 overflow-hidden"
      >
        <SessionInfoPanel {...panelProps} />
      </PopoverContent>
    </Popover>
  );
}

interface SessionInfoContentProps {
  runtimeProvider: string | undefined;
  runtimeSessionId?: string;
  featureId?: number;
  wsSessionId?: string;
  mcpServers: McpServerStatus[] | null;
  copiedField: CopiedField;
  resumeSupported: boolean;
  isRunning: boolean;
  onCopySessionId: () => Promise<void>;
  onCopyLaunchCommand: () => Promise<void>;
  claudeProfile?: string;
  claudeProfiles: ClaudeCodeProfile[];
  claudeProfilesLoading: boolean;
  claudeProfilesError: boolean;
  activeClaudeProfile?: string;
  onClaudeProfileChange?: (profile: string) => void;
  showProfileSelector: boolean;
}

function SessionInfoContent({
  runtimeProvider,
  runtimeSessionId,
  featureId,
  wsSessionId,
  mcpServers,
  copiedField,
  resumeSupported,
  isRunning,
  onCopySessionId,
  onCopyLaunchCommand,
  claudeProfile,
  claudeProfiles,
  claudeProfilesLoading,
  claudeProfilesError,
  activeClaudeProfile,
  onClaudeProfileChange,
  showProfileSelector,
}: SessionInfoContentProps): ReactElement {
  const providerMeta = getProviderMetadata(runtimeProvider);
  return (
    <>
      <ProviderRow providerId={runtimeProvider} providerLabel={providerMeta?.label} />
      {runtimeSessionId && <McpServersRow servers={mcpServers} />}
      <div className="shrink-0 space-y-3">
        {showProfileSelector && (
          <ProfileRow
            profile={claudeProfile}
            profiles={claudeProfiles}
            isLoading={claudeProfilesLoading}
            isError={claudeProfilesError}
            activeProfile={activeClaudeProfile}
            onProfileChange={onClaudeProfileChange}
          />
        )}
        {runtimeSessionId && (
          <>
            <SessionIdRow
              runtimeSessionId={runtimeSessionId}
              copied={copiedField === "id"}
              onCopy={onCopySessionId}
            />
            <LaunchCommandRow
              copied={copiedField === "command"}
              supported={resumeSupported}
              isRunning={isRunning}
              onCopy={onCopyLaunchCommand}
            />
            {featureId != null && wsSessionId && (
              <SyncFromCliRow
                featureId={featureId}
                wsSessionId={wsSessionId}
                isRunning={isRunning}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}

function SessionIdRow({
  runtimeSessionId,
  copied,
  onCopy,
}: {
  runtimeSessionId: string;
  copied: boolean;
  onCopy: () => Promise<void>;
}): ReactElement {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">Session ID</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 select-all truncate rounded bg-muted/60 px-2 py-1 font-mono text-[11px]">
          {runtimeSessionId}
        </code>
        <Button
          type="button"
          variant="raised"
          size="icon-xs"
          onClick={onCopy}
          title="Copy session ID"
          aria-label="Copy session ID"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}

function LaunchCommandRow({
  copied,
  supported,
  isRunning,
  onCopy,
}: {
  copied: boolean;
  supported: boolean;
  isRunning: boolean;
  onCopy: () => Promise<void>;
}): ReactElement {
  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="raised"
        size="sm"
        className="w-full"
        onClick={onCopy}
        disabled={!supported}
      >
        {copied ? <CheckIcon /> : <TerminalIcon />}
        {copied ? "Copied" : "Copy launch command"}
      </Button>
      {!supported && (
        <p className="text-[11px] text-muted-foreground">Not supported for this provider.</p>
      )}
      {supported && isRunning && (
        <p className="text-[11px] text-muted-foreground">Copying will pause the running agent.</p>
      )}
    </div>
  );
}

interface ProviderRowProps {
  providerId: string | undefined;
  providerLabel: string | undefined;
}

function ProviderRow({ providerId, providerLabel }: ProviderRowProps): ReactElement | null {
  if (!providerId) return null;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <ProviderIcon
        providerId={providerId}
        alt={providerLabel ?? providerId}
        className="size-4 rounded-sm"
      />
      <span className="text-xs font-medium">{providerLabel ?? providerId}</span>
    </div>
  );
}

function ProfileRow({
  profile,
  profiles,
  isLoading,
  isError,
  activeProfile,
  onProfileChange,
}: {
  profile?: string;
  profiles: ClaudeCodeProfile[];
  isLoading: boolean;
  isError: boolean;
  activeProfile?: string;
  onProfileChange?: (profile: string) => void;
}): ReactElement {
  const selectedProfile = profile ?? DEFAULT_CLAUDE_PROFILE_NAME;
  const selectedLabel = resolveProfileLabel(selectedProfile, profiles);
  const activeLabel = activeProfile ? resolveProfileLabel(activeProfile, profiles) : undefined;
  // Compare labels, not raw names: the backend spells the default profile
  // several ways ("default", "default (recommended)"), and a raw comparison
  // would claim the active profile differs from a selection that *is* it.
  const overridesActive = !!activeProfile && activeLabel !== selectedLabel;

  if (onProfileChange) {
    return (
      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-muted-foreground">Profile</div>
        <ClaudeProfileCombobox
          value={selectedProfile}
          profiles={profiles}
          isLoading={isLoading}
          isError={isError}
          onChange={onProfileChange}
          activeProfile={activeProfile}
          triggerClassName="w-full justify-between"
        />
        <p className="text-[11px] text-muted-foreground">
          Applies to the next prompt. Current running turn is not restarted.
          {overridesActive && ` “${activeLabel}” stays the active profile.`}
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-medium text-muted-foreground">Profile</span>
      {isLoading && <span className="h-3 w-16 animate-pulse rounded bg-muted/60" />}
      {isError && <span className="text-[11px] text-destructive">Failed to load</span>}
      {!isLoading && !isError && (
        <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
          {selectedLabel}
        </span>
      )}
    </div>
  );
}

function resolveProfileLabel(profileId: string, profiles: ClaudeCodeProfile[]): string {
  return (
    profiles.find((profile) => profile.name === profileId)?.label ??
    formatClaudeProfileLabel(profileId)
  );
}

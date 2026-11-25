import { useCallback, useEffect, type ReactElement } from "react";
import { useNavigate } from "@tanstack/react-router";
import { HistoryIcon, InboxIcon, Loader2Icon, LoaderIcon } from "lucide-react";
import type { Feature } from "@/api/generated";
import { CenteredMessage, PhoneHomeFrame } from "@/components/PhoneHomeChrome";
import { SidebarRowActionsProvider } from "@/components/SidebarRowActionsProvider";
import { SidebarShowMoreButton } from "@/components/SidebarShowMore";
import { Button } from "@/components/ui/button";
import { InboxCard } from "@/components/phone-inbox/PhoneInboxCard";
import { ForMeCard } from "@/components/phone-inbox/PhoneInboxForMeCard";
import { NewConversation } from "@/components/phone-inbox/PhoneInboxNewConversation";
import { InboxSection } from "@/components/phone-inbox/PhoneInboxSection";
import { usePhoneInbox, type PhoneInboxData } from "@/components/phone-inbox/usePhoneInbox";
import { useForMeShowMore } from "@/hooks/useForMeShowMore";
import { useOpenGateQuickReply } from "@/hooks/useOpenGateQuickReply";
import { prefetchAgentSession } from "@/components/lazy/agent-session-chunk";
import { scheduleIdle } from "@/lib/schedule-idle";
import { navigateToConversation } from "@/lib/conversation-route";
import { isStrongAction } from "@/lib/next-actions";

/**
 * The phone layout's home: the "Agents" inbox. For me (what waits on the
 * user, answered from here through the quick reply sheet), In progress
 * (agents at work) and Recent (the conversations touched last), across
 * projects. A card's body opens its conversation.
 */
export function PhoneInbox(): ReactElement {
  const inbox = usePhoneInbox();
  const navigate = useNavigate();
  const { projectsById } = inbox;
  const open = useCallback(
    (feature: Feature): void => {
      const project = projectsById.get(feature.project_id);
      navigateToConversation(navigate, feature.project_id, feature.id, {
        cwd: project?.path,
        featureKnown: true,
      });
    },
    [navigate, projectsById],
  );
  const openQuickReply = useOpenGateQuickReply();
  usePrefetchConversationView(!inbox.projects.loading && !inbox.recent.loading);
  return (
    <PhoneHomeFrame
      title="Agents"
      menuBadge={false}
      actions={<NewConversation projects={inbox.projects.rows} variant="icon" />}
    >
      <div
        data-phone-inbox
        className="h-full overflow-y-auto overscroll-contain px-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]"
      >
        {/* A card's swipe actions and the archive dialog they share. */}
        <SidebarRowActionsProvider>
          <InboxContent inbox={inbox} onOpen={open} onQuickReply={openQuickReply} />
        </SidebarRowActionsProvider>
      </div>
    </PhoneHomeFrame>
  );
}

/** How long the conversation view's prefetch waits for an idle period before it runs anyway. */
export const CONVERSATION_VIEW_PREFETCH_TIMEOUT_MS = 2_000;

/**
 * The phone layout boots without the conversation view's chunk (the largest
 * one): fetched at boot, it would compete with pairing, the runtime config and
 * the inbox's own requests for the browser's six connections. It is fetched
 * at the first idle period once the cards are up, or as soon as a card is
 * pressed (`preloadPressedConversation`), whichever comes first.
 */
function usePrefetchConversationView(cardsShown: boolean): void {
  useEffect(() => {
    if (!cardsShown) return undefined;
    return scheduleIdle(() => void prefetchAgentSession(), {
      timeout: CONVERSATION_VIEW_PREFETCH_TIMEOUT_MS,
    });
  }, [cardsShown]);
}

interface ContentProps {
  inbox: PhoneInboxData;
  onOpen: (feature: Feature) => void;
  onQuickReply: (featureId: number) => void;
}

/**
 * The sections, held on skeletons until the projects are known (a card names
 * its project). A projects error shows above them with Retry; the page-wide
 * empty states wait for the projects to load.
 */
function InboxContent({ inbox, onOpen, onQuickReply }: ContentProps): ReactElement {
  const { forMe, working, recent, projects } = inbox;
  const projectsKnown = !projects.loading && !projects.error;
  if (projectsKnown && projects.rows.length === 0) {
    return (
      <CenteredMessage
        tone="foreground"
        title="No projects yet"
        detail="Open the menu and use its + button to add a project"
      />
    );
  }
  const nothing = [forMe, working, recent].every(
    (section) => !section.loading && !section.error && section.rows.length === 0,
  );
  if (projectsKnown && nothing) {
    return (
      <CenteredMessage
        tone="foreground"
        title="No conversations yet"
        detail="Start one: what your agents ask, work on and finish shows up here."
        action={<NewConversation projects={projects.rows} variant="button" />}
      />
    );
  }
  const held = projects.loading;
  return (
    <div className="flex flex-col gap-6">
      {projects.error && (
        <ProjectsError
          message={projects.error}
          retrying={inbox.projectsRetrying}
          onRetry={inbox.retryProjects}
        />
      )}
      <ForMeSection inbox={inbox} held={held} onOpen={onOpen} onQuickReply={onQuickReply} />
      <InboxSection
        label="In progress"
        icon={LoaderIcon}
        count={held ? undefined : working.rows.length}
        loading={held || working.loading}
        error={working.error}
        empty="No agent at work"
        isEmpty={held || working.rows.length === 0}
      >
        {working.rows.map((feature) => (
          <InboxCard
            key={feature.id}
            feature={feature}
            projectName={inbox.projectsById.get(feature.project_id)?.name}
            working
            onOpen={onOpen}
          />
        ))}
      </InboxSection>
      <InboxSection
        label="Recent"
        icon={HistoryIcon}
        loading={held || recent.loading}
        error={recent.error}
        empty="Nothing else lately"
        isEmpty={held || recent.rows.length === 0}
      >
        {recent.rows.map((feature) => (
          <InboxCard
            key={feature.id}
            feature={feature}
            projectName={inbox.projectsById.get(feature.project_id)?.name}
            onOpen={onOpen}
          />
        ))}
      </InboxSection>
    </div>
  );
}

/** For me, capped like the sidebar's block ("For me shows"), "Show N more" under it. */
function ForMeSection({
  inbox,
  held,
  onOpen,
  onQuickReply,
}: ContentProps & { held: boolean }): ReactElement {
  const { forMe, projectsById } = inbox;
  const more = useForMeShowMore(forMe.rows.length);
  return (
    <InboxSection
      label="For me"
      icon={InboxIcon}
      count={held ? undefined : forMe.rows.length}
      strong={forMe.rows.some(isStrongAction)}
      loading={held || forMe.loading}
      error={forMe.error}
      empty="Nothing waiting on you"
      isEmpty={held || forMe.rows.length === 0}
      footer={held ? null : <SidebarShowMoreButton more={more} />}
    >
      {forMe.rows.slice(0, more.visibleCount).map(({ feature, kind }) => (
        <ForMeCard
          key={feature.id}
          feature={feature}
          kind={kind}
          projectName={projectsById.get(feature.project_id)?.name}
          onOpen={onOpen}
          onQuickReply={onQuickReply}
        />
      ))}
    </InboxSection>
  );
}

function ProjectsError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}): ReactElement {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-xl border border-destructive/40 py-1 pr-1 pl-3"
    >
      <p className="min-w-0 flex-1 text-sm text-destructive">{message}</p>
      <Button variant="outline" className="min-h-11 shrink-0" disabled={retrying} onClick={onRetry}>
        {retrying && <Loader2Icon className="animate-spin" />}
        Retry
      </Button>
    </div>
  );
}

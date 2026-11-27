import { memo, type ReactElement, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ConversationLayer } from "./ConversationLayer";
import { routedContentKey, stageLayout } from "./stage-route";

/**
 * The app shell's main area: the routed page, and the conversation layer
 * (`ConversationLayer`) over it. Its tree never changes shape with the layout
 * or the panes, so a fold, a rotation or a window crossing the phone width
 * re-renders it in place: the workspace on screen stays mounted, scrolled
 * where it was, its dialogs open.
 *
 * On a conversation the routed page renders nothing and the layer shows the
 * conversation; on the phone inbox the layer stays mounted, every workspace
 * hidden, so going back is a flip.
 *
 * A leaf that selects its own key, so a conversation switch (same key)
 * renders nothing in the root chain above it.
 */
export const RoutedStage = memo(function RoutedStage({
  outlet,
}: {
  outlet: ReactNode;
}): ReactElement {
  // Keyed on the committed matches, not on `location`: the location moves when
  // a navigation starts and the matches (what the outlet and the conversation
  // layer render) when it commits, so a key read from the location remounted
  // the old page and showed the layer without a conversation for a frame.
  // No route matched: only the root match is left, whose pathname is "/" —
  // key the not-found page on its own location so it is never the home page.
  const contentKey = useRouterState({
    select: (state) => {
      const leaf = state.matches.at(-1);
      const unmatched = !leaf || leaf.routeId === "__root__";
      return routedContentKey(unmatched ? state.location.pathname : leaf.pathname);
    },
  });
  const layout = stageLayout(contentKey, useIsMobile());
  return (
    <div className="relative h-full w-full">
      <RootErrorBoundary>
        <div key={contentKey} className="h-full animate-in fade-in-0 duration-200 ease-out">
          {outlet}
        </div>
        {layout.keepConversations ? <ConversationLayer shown={layout.conversationShown} /> : null}
      </RootErrorBoundary>
    </div>
  );
});

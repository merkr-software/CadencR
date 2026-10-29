import { useCallback, useState, type ReactElement } from "react";
import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useListCustomActions, type CustomAction } from "@/api/generated";
import { CustomActionButton } from "./CustomActionButton";
import { CustomActionDetails } from "./CustomActionDetails";
import { CustomActionEditorDialog } from "./CustomActionEditorDialog";
import { CustomActionsOverflowDropdown } from "./CustomActionsOverflowDropdown";

interface CustomActionsBarProps {
  featureId: number;
  projectId: number;
}

/** Up to this many actions show inline; the rest collapse into the overflow menu. */
const MAX_INLINE = 4;

/**
 * Per-feature custom-action toolbar in the header.
 *
 * Layout: `[act1] [act2] [act3] [act4] [⋯ overflow] [+ add]`. The first four
 * actions render inline; any beyond that move into the overflow menu, keeping
 * the add button in a stable position. On phones every action collapses into
 * the overflow menu (`[⋯] [+]`) so the cramped header keeps room for the title.
 *
 * Both inline buttons and overflow entries open one shared details/output
 * popover (anchored to the toolbar), so output is reachable identically for
 * every action. Status dots live in the always-present buttons and are kept
 * live by a poll while a run is in flight, so long-running actions stay visible
 * even after the popover/menu closes.
 */
export function CustomActionsBar({ featureId, projectId }: CustomActionsBarProps): ReactElement {
  const isMobile = useIsMobile();
  const { data: actions = [] } = useListCustomActions(
    { project_id: projectId, feature_id: featureId },
    {
      query: {
        refetchInterval: (query) =>
          (query.state.data ?? []).some(
            (action) => action.last_run != null && action.last_run.ended_at == null,
          )
            ? 2000
            : false,
      },
    },
  );

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<CustomAction | undefined>(undefined);
  const [detailsId, setDetailsId] = useState<number | null>(null);

  const openCreate = useCallback((): void => {
    setEditorTarget(undefined);
    setEditorOpen(true);
  }, []);
  const openEdit = useCallback((action: CustomAction): void => {
    setEditorTarget(action);
    setEditorOpen(true);
  }, []);
  const openDetails = useCallback((action: CustomAction): void => {
    setDetailsId(action.id);
  }, []);

  const maxInline = isMobile ? 0 : MAX_INLINE;
  const inline = actions.length <= maxInline ? actions : actions.slice(0, maxInline);
  const overflow = actions.length <= maxInline ? [] : actions.slice(maxInline);
  // Resolve from the live list so the panel keeps streaming fresh data while open.
  const detailsAction =
    detailsId != null ? (actions.find((a) => a.id === detailsId) ?? null) : null;

  return (
    <>
      <Popover
        open={detailsAction != null}
        onOpenChange={(open) => {
          if (!open) setDetailsId(null);
        }}
      >
        <PopoverAnchor asChild>
          <div className="flex items-center gap-0.5">
            {inline.map((action) => (
              <CustomActionButton
                key={action.id}
                action={action}
                featureId={featureId}
                projectId={projectId}
                onOpenDetails={openDetails}
                detailsOpen={detailsAction?.id === action.id}
              />
            ))}
            {overflow.length > 0 && (
              <CustomActionsOverflowDropdown actions={overflow} onOpenDetails={openDetails} />
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-xs"
              title="Add custom action"
              onClick={openCreate}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="end"
          className="w-[44rem] max-w-[90vw]"
          aria-label={detailsAction ? `${detailsAction.name} details` : undefined}
        >
          {detailsAction && (
            <CustomActionDetails
              // Remount per action so variable drafts never leak between actions.
              key={detailsAction.id}
              action={detailsAction}
              featureId={featureId}
              projectId={projectId}
              onEdit={() => {
                setDetailsId(null);
                openEdit(detailsAction);
              }}
              onAfterDelete={() => setDetailsId(null)}
            />
          )}
        </PopoverContent>
      </Popover>

      <CustomActionEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        projectId={projectId}
        featureId={featureId}
        action={editorTarget}
      />
    </>
  );
}

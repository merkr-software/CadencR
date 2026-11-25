import { translateUi } from "@/lib/i18n/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import {
  desktopBridge,
  type BrowserBounds,
  type BrowserElementContext,
} from "@/lib/desktop-bridge";
import type { BrowserWorkspaceModel } from "./useBrowserWorkspaceModel";
import { showBrowserError } from "./browser-errors";
import { formatComments, type BrowserComment } from "./format-context";

interface UseBrowserCommentsArgs {
  runForActive: BrowserWorkspaceModel["runForActive"];
  onSend: (message: string, images?: Array<{ base64: string; mimeType: string }>) => void;
}

/** The element currently being written about in the positioned CommentForm. */
export interface BrowserCommentDraft {
  id: string;
  context: BrowserElementContext;
  initialText: string;
  /** Viewport rect of the anchored element, to position the form. */
  box: BrowserBounds | null;
  /** Whether the captured screenshot is attached when this comment is sent. */
  includeScreenshot: boolean;
  /** True when re-opening a saved comment rather than composing a new one. */
  editing: boolean;
  /** 1-based number shown on the form, matching the on-page badge. */
  number: number;
}

export interface BrowserCommentsController {
  /** Saved comments, in pick order — their numbers match the on-page badges. */
  comments: BrowserComment[];
  /** The open composer, or null. */
  draft: BrowserCommentDraft | null;
  /** True while the element picker is armed on the page. */
  picking: boolean;
  /** Arm the picker to anchor a new comment to an element. */
  addComment: () => void;
  /** Commit the composer text (new comment or edit). */
  saveDraft: (text: string) => void;
  /** Close the composer, dropping a never-saved badge. */
  cancelDraft: () => void;
  /** Flip whether the open draft's screenshot is attached on send. */
  toggleDraftScreenshot: () => void;
  /** Delete a saved comment and its badge. */
  removeComment: (id: string) => void;
  /** Drop every pending comment and clear all badges. */
  discardAll: () => void;
  /** Send all saved comments as one message and clear the badges. */
  send: () => void;
}

function useBrowserBadgeActions(): {
  clearBadges: (tabId: string) => void;
  removeBadge: (tabId: string, anchorId: string) => void;
} {
  const clearBadges = useCallback((tabId: string): void => {
    void desktopBridge
      .clearBrowserCommentBadges(tabId)
      .catch((error: unknown) =>
        showBrowserError(
          error,
          translateUi(
            "workspace.tools.useBrowserComments.couldNotClearBrowserBadges",
            "Could not clear Browser badges",
          ),
        ),
      );
  }, []);
  const removeBadge = useCallback((tabId: string, anchorId: string): void => {
    void desktopBridge
      .removeBrowserCommentBadge(tabId, anchorId)
      .catch((error: unknown) =>
        showBrowserError(
          error,
          translateUi(
            "workspace.tools.useBrowserComments.couldNotUpdateBrowserBadges",
            "Could not update Browser badges",
          ),
        ),
      );
  }, []);
  return useMemo(() => ({ clearBadges, removeBadge }), [clearBadges, removeBadge]);
}

function useBadgeClickDraft(
  commentsRef: MutableRefObject<BrowserComment[]>,
  draftRef: MutableRefObject<BrowserCommentDraft | null>,
  setDraft: Dispatch<SetStateAction<BrowserCommentDraft | null>>,
): void {
  useEffect(
    () =>
      desktopBridge.onBrowserCommentBadgeClick(({ anchorId, box }) => {
        if (draftRef.current) return;
        const index = commentsRef.current.findIndex((comment) => comment.id === anchorId);
        if (index < 0) return;
        const comment = commentsRef.current[index];
        setDraft({
          id: comment.id,
          context: comment.context,
          initialText: comment.text,
          box: box ?? comment.context.element.boundingBox,
          includeScreenshot: comment.includeScreenshot,
          editing: true,
          number: index + 1,
        });
      }),
    [commentsRef, draftRef, setDraft],
  );
}

function useCommentCollectionActions(
  comments: BrowserComment[],
  commentsRef: MutableRefObject<BrowserComment[]>,
  clearBadges: (tabId: string) => void,
  onSend: UseBrowserCommentsArgs["onSend"],
  setComments: Dispatch<SetStateAction<BrowserComment[]>>,
  setDraft: Dispatch<SetStateAction<BrowserCommentDraft | null>>,
): Pick<BrowserCommentsController, "discardAll" | "send"> {
  const discardAll = useCallback((): void => {
    for (const tabId of new Set(commentsRef.current.map((comment) => comment.context.tabId))) {
      clearBadges(tabId);
    }
    setComments([]);
    setDraft(null);
  }, [clearBadges, commentsRef, setComments, setDraft]);
  const send = useCallback((): void => {
    if (comments.length === 0) return;
    const images = comments
      .filter((comment) => comment.includeScreenshot)
      .map((comment) => ({ base64: comment.context.screenshotPngBase64, mimeType: "image/png" }));
    onSend(formatComments(comments), images.length > 0 ? images : undefined);
    for (const tabId of new Set(comments.map((comment) => comment.context.tabId))) {
      clearBadges(tabId);
    }
    setComments([]);
    setDraft(null);
    toast.success(
      translateUi("workspace.tools.useBrowserComments.sent", {
        count: comments.length,
        defaultValue_one: "Browser comment sent to the active agent.",
        defaultValue_other: "{{count}} browser comments sent to the active agent.",
      }),
    );
  }, [clearBadges, comments, onSend, setComments, setDraft]);
  return useMemo(() => ({ discardAll, send }), [discardAll, send]);
}

function useCommentDraftActions(
  commentsRef: MutableRefObject<BrowserComment[]>,
  includeScreenshotDefault: MutableRefObject<boolean>,
  removeBadge: (tabId: string, anchorId: string) => void,
  setComments: Dispatch<SetStateAction<BrowserComment[]>>,
  setDraft: Dispatch<SetStateAction<BrowserCommentDraft | null>>,
): Pick<
  BrowserCommentsController,
  "saveDraft" | "cancelDraft" | "toggleDraftScreenshot" | "removeComment"
> {
  const saveDraft = useCallback((text: string): void => {
    setDraft((current) => {
      if (!current) return null;
      includeScreenshotDefault.current = current.includeScreenshot;
      setComments((previous) =>
        previous.some((comment) => comment.id === current.id)
          ? previous.map((comment) =>
              comment.id === current.id
                ? { ...comment, text, includeScreenshot: current.includeScreenshot }
                : comment,
            )
          : [
              ...previous,
              {
                id: current.id,
                context: current.context,
                text,
                includeScreenshot: current.includeScreenshot,
              },
            ],
      );
      return null;
    });
  }, []);
  const cancelDraft = useCallback((): void => {
    setDraft((current) => {
      if (current && !commentsRef.current.some((comment) => comment.id === current.id)) {
        removeBadge(current.context.tabId, current.id);
      }
      return null;
    });
  }, [commentsRef, removeBadge, setDraft]);
  const toggleDraftScreenshot = useCallback((): void => {
    setDraft((current) =>
      current ? { ...current, includeScreenshot: !current.includeScreenshot } : current,
    );
  }, [setDraft]);
  const removeComment = useCallback(
    (id: string): void => {
      const comment = commentsRef.current.find((candidate) => candidate.id === id);
      setComments((previous) => previous.filter((candidate) => candidate.id !== id));
      setDraft((current) => (current?.id === id ? null : current));
      if (comment) removeBadge(comment.context.tabId, id);
    },
    [commentsRef, removeBadge, setComments, setDraft],
  );
  return useMemo(
    () => ({ saveDraft, cancelDraft, toggleDraftScreenshot, removeComment }),
    [cancelDraft, removeComment, saveDraft, toggleDraftScreenshot],
  );
}

/**
 * Collects element-anchored comments before sending them to the agent as one
 * message. Picking an element pins a numbered badge to it on the page and opens
 * the shared CommentForm positioned under the element; saving keeps just the
 * badge. Clicking a badge (relayed from the guest page) reopens its comment to
 * edit. The per-draft screenshot toggle decides whether the captured image is
 * attached on send, and its last value seeds the next comment.
 */
export function useBrowserComments(args: UseBrowserCommentsArgs): BrowserCommentsController {
  const { runForActive, onSend } = args;
  const [comments, setComments] = useState<BrowserComment[]>([]);
  const [draft, setDraft] = useState<BrowserCommentDraft | null>(null);
  const [picking, setPicking] = useState(false);
  // Sticky default for the screenshot toggle, carried to the next comment.
  const includeScreenshotDefault = useRef(true);
  // Latest state for the badge-click subscription, which is mounted once.
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const { clearBadges, removeBadge } = useBrowserBadgeActions();

  const addComment = useCallback((): void => {
    if (picking) return;
    setPicking(true);
    const anchorId = crypto.randomUUID();
    void runForActive(async (tab) => {
      const context = await desktopBridge.selectBrowserElementContext(tab.id, anchorId);
      setDraft({
        id: anchorId,
        context,
        initialText: "",
        box: context.element.boundingBox,
        includeScreenshot: includeScreenshotDefault.current,
        editing: false,
        number: commentsRef.current.length + 1,
      });
    }).finally(() => setPicking(false));
  }, [picking, runForActive]);

  const draftActions = useCommentDraftActions(
    commentsRef,
    includeScreenshotDefault,
    removeBadge,
    setComments,
    setDraft,
  );

  useBadgeClickDraft(commentsRef, draftRef, setDraft);
  const collectionActions = useCommentCollectionActions(
    comments,
    commentsRef,
    clearBadges,
    onSend,
    setComments,
    setDraft,
  );

  return useMemo(
    () => ({
      comments,
      draft,
      picking,
      addComment,
      ...draftActions,
      ...collectionActions,
    }),
    [addComment, collectionActions, comments, draft, draftActions, picking],
  );
}

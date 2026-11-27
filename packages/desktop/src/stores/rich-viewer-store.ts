import type { ReactNode } from "react";
import { create } from "zustand";
import type { OpenDiffInEditor } from "@/components/diff/OpenDiffInEditorContext";
import type { LinkRouting } from "@/components/links/LinkRoutingContext";

/** What the phone layout's full-screen viewer shows: a message's table or code block. */
export type RichViewerContent =
  | { kind: "table"; title: string; content: ReactNode }
  | { kind: "code"; title: string; code: string; content: ReactNode };

/**
 * The link actions of the message the block sits in, so a link in the viewer
 * (rendered at the root, outside the transcript) opens as it would there.
 */
export interface RichViewerLinks {
  routing: LinkRouting | null;
  openInEditor: OpenDiffInEditor | undefined;
}

interface OpenRichViewer {
  viewer: RichViewerContent;
  links: RichViewerLinks;
  /** The block that opened it, which may refresh it while it streams. */
  owner: object;
}

interface RichViewerState {
  open: OpenRichViewer | null;
  close: () => void;
}

/**
 * The single full-screen rich block, owned globally for the same reason as
 * `mermaid-fullscreen-store`: stream rows are virtualized, so a dialog
 * portalled from inside a message dies when Virtuoso recycles that row. Only
 * `RichContentViewerHost` subscribes.
 */
export const useRichViewerStore = create<RichViewerState>((set) => ({
  open: null,
  close: () => set({ open: null }),
}));

/** Open a block full screen from anywhere without subscribing to the store. */
export function openRichViewer(
  owner: object,
  viewer: RichViewerContent,
  links: RichViewerLinks,
): void {
  useRichViewerStore.setState({ open: { owner, viewer, links } });
}

/** A streaming block's newer content, shown only if that block's viewer is still open. */
export function refreshRichViewer(owner: object, viewer: RichViewerContent): void {
  const open = useRichViewerStore.getState().open;
  if (open?.owner !== owner || open.viewer === viewer) return;
  useRichViewerStore.setState({ open: { ...open, viewer } });
}

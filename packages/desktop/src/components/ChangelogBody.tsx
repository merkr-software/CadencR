import { memo, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { ChangelogImage } from "@/components/ChangelogImage";
import { Markdown } from "@/components/Markdown";
import { MarkdownImageProvider } from "@/components/markdown-image";

/**
 * Discriminated state for changelog rendering, shared by the pre-install
 * dialog (`SidebarUpdateButton`) and the post-install dialog
 * (`PostUpdateChangelogDialog`). Keeping a single component for both means
 * the two surfaces stay visually identical as the design evolves.
 */
export type ChangelogBodyState =
  | { kind: "loading" }
  | { kind: "markdown"; markdown: string }
  | { kind: "missing" };

export const ChangelogBody = memo(function ChangelogBody({
  state,
}: {
  state: ChangelogBodyState;
}): ReactElement {
  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading release notes…
      </div>
    );
  }
  if (state.kind === "missing") {
    return (
      <div className="py-2 text-xs text-muted-foreground">
        Release notes aren't published yet. Open the full changelog to see the latest updates.
      </div>
    );
  }
  return (
    <div className="max-h-[calc(var(--app-vh)*0.6)] overflow-y-auto pr-1">
      <MarkdownImageProvider value={ChangelogImage}>
        <Markdown content={state.markdown} />
      </MarkdownImageProvider>
    </div>
  );
});

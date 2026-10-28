import { useMemo, useState, type ReactElement } from "react";
import { ArrowUpCircle, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateStore, type UpdateStatus } from "@/stores/update-store";
import { desktopBridge } from "@/lib/desktop-bridge";
import { CHANGELOG_URL, SIDEBAR_FOOTER_PILL_CLASS } from "@/lib/changelog";
import { ChangelogBody, type ChangelogBodyState } from "@/components/ChangelogBody";
import { UpdateInstallActions, UpdateInstallNotice } from "@/components/UpdateInstallActions";
import { cn } from "@/lib/utils";

/**
 * Sidebar footer affordance for pending app updates. Rendered above the
 * Settings link in `Sidebar`. Hidden entirely when no update is in flight —
 * so the sidebar stays uncluttered on the happy path.
 *
 * Replaces the previous "Update ready" toast. Clicking opens a dialog with
 * the new version's release notes, a Restart-to-install action when the
 * update has finished downloading, and a link to the public changelog.
 */
export function SidebarUpdateButton(): ReactElement | null {
  const status = useUpdateStore((s) => s.status);
  const version = useUpdateStore((s) => s.version);
  const progress = useUpdateStore((s) => s.progress);
  const waitingForAgents = useUpdateStore((s) => s.installWhenAgentsFinish);
  const [open, setOpen] = useState(false);

  if (!isPendingStatus(status)) return null;
  const label = waitingForAgents ? "Updating after agents finish" : triggerLabel(status, version);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-nav-item
        className={cn(SIDEBAR_FOOTER_PILL_CLASS, "text-foreground/90")}
        title={waitingForAgents ? label : triggerTitle(status, version)}
      >
        <span className="flex items-center gap-2">
          <ArrowUpCircle className="size-4 text-primary" aria-hidden />
          <span>{label}</span>
        </span>
        {status === "downloading" ? (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {Math.round(progress)}%
          </span>
        ) : status === "downloaded" ? (
          <span aria-hidden className="size-1.5 rounded-full bg-primary" title="Update ready" />
        ) : null}
      </button>

      {/* Mount the dialog only while open so download-progress ticks don't
          re-render the whole portal subtree. */}
      {open && <UpdateDialog onOpenChange={setOpen} />}
    </>
  );
}

/**
 * Pulled out so the heavy bits (Dialog, markdown body, multiple store
 * selectors) only mount when the user actually opens the panel.
 */
function UpdateDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }): ReactElement {
  const status = useUpdateStore((s) => s.status);
  const version = useUpdateStore((s) => s.version);
  const changelogMarkdown = useUpdateStore((s) => s.changelogMarkdown);
  const changelogLoading = useUpdateStore((s) => s.changelogLoading);
  const progress = useUpdateStore((s) => s.progress);

  const bodyState = useMemo<ChangelogBodyState>(
    () => deriveBodyState(changelogMarkdown, changelogLoading),
    [changelogMarkdown, changelogLoading],
  );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {status === "downloaded"
              ? `Update v${version ?? ""} ready to install`
              : `Update v${version ?? ""} available`}
          </DialogTitle>
          <DialogDescription>
            {status === "downloaded"
              ? "Restart Cadencr to finish installing."
              : status === "downloading"
                ? `Downloading… ${Math.round(progress)}%`
                : "Cadencr is preparing the new version."}
          </DialogDescription>
        </DialogHeader>

        <ChangelogBody state={bodyState} />
        {status === "downloaded" && <UpdateInstallNotice />}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => void desktopBridge.openExternal(CHANGELOG_URL)}>
            <ExternalLink className="size-4" aria-hidden />
            View full changelog
          </Button>
          {status === "downloaded" ? (
            <UpdateInstallActions />
          ) : (
            <Button disabled>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Downloading…
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isPendingStatus(status: UpdateStatus): boolean {
  return status === "available" || status === "downloading" || status === "downloaded";
}

function triggerLabel(status: UpdateStatus, version: string | null): string {
  const tag = version ? `v${version}` : "update";
  return status === "downloaded" ? `Update to ${tag}` : `Downloading ${tag}`;
}

function triggerTitle(status: UpdateStatus, version: string | null): string {
  if (status === "downloaded") {
    return version ? `Restart to install v${version}` : "Restart to install update";
  }
  return "Update downloading";
}

function deriveBodyState(markdown: string | null, loading: boolean): ChangelogBodyState {
  if (markdown) return { kind: "markdown", markdown };
  if (loading) return { kind: "loading" };
  return { kind: "missing" };
}

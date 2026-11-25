import { useUiTranslation } from "@/lib/i18n/ui";
import { useEffect, useState, type ReactElement } from "react";
import { ExternalLink, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { APP_VERSION } from "@/lib/app-version";
import { LAST_SEEN_VERSION_KEY, openFullChangelog } from "@/lib/changelog";
import { desktopBridge } from "@/lib/desktop-bridge";
import { ChangelogBody, type ChangelogBodyState } from "@/components/ChangelogBody";

/**
 * One-shot "What's new" dialog: opened automatically on the first launch
 * after the running `APP_VERSION` changes. We track the last-seen version
 * in localStorage. First-ever launches (no stored version) seed the value
 * silently so a fresh install doesn't greet the user with a changelog.
 *
 * Fetches the release notes for the *new* (now-running) version from the
 * GitHub Releases API and renders them inline. Falls back to a "not
 * published" notice when the release body isn't available.
 */
export function PostUpdateChangelogDialog(): ReactElement | null {
  const { t } = useUiTranslation();
  const [previousVersion, setPreviousVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [changelog, setChangelog] = useState<ChangelogBodyState>({ kind: "loading" });

  useEffect(() => {
    const stored = readLastSeenVersion();
    if (stored && stored !== APP_VERSION) {
      setPreviousVersion(stored);
      setOpen(true);
    }
    writeLastSeenVersion(APP_VERSION);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setChangelog({ kind: "loading" });
    void desktopBridge
      .fetchChangelog(APP_VERSION)
      .then((markdown) => {
        if (cancelled) return;
        setChangelog(
          markdown && markdown.trim().length > 0
            ? { kind: "markdown", markdown }
            : { kind: "missing" },
        );
      })
      .catch(() => {
        if (cancelled) return;
        setChangelog({ kind: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden />
            {t("system.changelog.updatedVersion", "Cadencr updated to v{{version}}", {
              version: APP_VERSION,
            })}
          </DialogTitle>
          <DialogDescription>
            {previousVersion
              ? t(
                  "system.changelog.previousVersion",
                  "You were on v{{version}}. Here's what's new in this release.",
                  { version: previousVersion },
                )
              : t("system.changelog.whatsNew", "Here's what's new in this release.")}
          </DialogDescription>
        </DialogHeader>

        <ChangelogBody state={changelog} />

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("system.postUpdateChangelogDialog.dismiss", "Dismiss")}
          </Button>
          <Button
            onClick={() => {
              void openFullChangelog().then((opened) => {
                if (opened) setOpen(false);
              });
            }}
          >
            <ExternalLink className="size-4" aria-hidden />
            {t("sidebar.updateButton.viewFullChangelog", "View full changelog")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function readLastSeenVersion(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_VERSION_KEY);
  } catch (error) {
    console.warn("[changelog] failed to read last-seen version:", error);
    return null;
  }
}

function writeLastSeenVersion(version: string): void {
  try {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, version);
  } catch (error) {
    console.warn("[changelog] failed to persist last-seen version:", error);
  }
}

import { useUiTranslation } from "@/lib/i18n/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface SettingsJsonDialogShellProps {
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  path?: string;
  children: React.ReactNode;
}

/**
 * Shared frame for the settings "Edit JSON" dialog: the large fixed sizing plus
 * the header (title + file path). Used by both the lazy editor and its Suspense
 * fallback so the two can't drift in size or title.
 */
export function SettingsJsonDialogShell({
  open = true,
  onOpenChange,
  title,
  path,
  children,
}: SettingsJsonDialogShellProps): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[90vw] sm:max-w-7xl flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-semibold">
            {t("settings.general.json.editorTitle", "{{title}}: Edit JSON", { title })}
          </DialogTitle>
          {path ? (
            <p className="truncate font-mono text-[11px] text-muted-foreground">{path}</p>
          ) : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

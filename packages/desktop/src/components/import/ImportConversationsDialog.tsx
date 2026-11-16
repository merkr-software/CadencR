import { memo, useCallback, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ImportProviderStep } from "./ImportProviderStep";
import { ImportConversationPickerStep } from "./ImportConversationPickerStep";
import { ImportProgressStep } from "./ImportProgressStep";
import { PROVIDER_IDS, getProviderMetadata, type ProviderId } from "@/lib/providers";

export type ImportStep = "provider" | "list" | "importing";

interface ImportConversationsDialogProps {
  projectId: number;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Modal shell + step machine for importing existing conversations from an
 * external provider into the active project. Children stay dumb — this
 * component owns step transitions and the in-flight job id.
 */
function ImportConversationsDialogInner({
  projectId,
  projectName,
  open,
  onOpenChange,
}: ImportConversationsDialogProps) {
  const [step, setStep] = useState<ImportStep>("provider");
  const [jobId, setJobId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<ProviderId>(PROVIDER_IDS.CLAUDE_CODE);

  const reset = useCallback(() => {
    setStep("provider");
    setJobId(null);
    setProviderId(PROVIDER_IDS.CLAUDE_CODE);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (!next) reset();
    },
    [onOpenChange, reset],
  );

  const handleImportStarted = useCallback((nextJobId: string) => {
    setJobId(nextJobId);
    setStep("importing");
  }, []);

  const handleClose = useCallback(() => handleOpenChange(false), [handleOpenChange]);
  const handleProviderSelect = useCallback((nextProviderId: ProviderId) => {
    setProviderId(nextProviderId);
    setStep("list");
  }, []);
  const providerLabel = getProviderMetadata(providerId)?.label ?? providerId;

  // Only the conversation-picker step needs a definite tall height so its
  // long inner list can flex-scroll. Every other step (provider cards,
  // in-flight progress bar, final summary) is short — letting the dialog
  // auto-size avoids the near-empty 80vh modal.
  const sizingClass = step === "list" ? "h-[80vh]" : "max-h-[min(80vh,var(--dialog-max-h))]";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={`flex w-[90vw] flex-col gap-0 p-0 sm:max-w-[640px] ${sizingClass}`}>
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-semibold">
            Import conversations — <span className="text-muted-foreground">{projectName}</span>
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">
            Pull existing conversations into this project. Already-imported sessions are skipped.
          </p>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col px-6 py-5">
          {step === "provider" && <ImportProviderStep onSelect={handleProviderSelect} />}
          {step === "list" && (
            <ImportConversationPickerStep
              projectId={projectId}
              providerId={providerId}
              providerLabel={providerLabel}
              onBack={() => setStep("provider")}
              onStarted={handleImportStarted}
            />
          )}
          {step === "importing" && jobId && (
            <ImportProgressStep jobId={jobId} projectId={projectId} onClose={handleClose} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const ImportConversationsDialog = memo(ImportConversationsDialogInner);

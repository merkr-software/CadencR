import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { FullscreenDialog } from "@/components/FullscreenDialog";
import { MermaidDiagramView } from "@/components/MermaidDiagramView";
import { useMermaidFullscreenStore } from "@/stores/mermaid-fullscreen-store";

/**
 * The app's single full-screen diagram view, mounted once beside the other
 * root overlays.
 */
export function MermaidFullscreenHost(): ReactElement {
  const { t } = useUiTranslation();
  const svg = useMermaidFullscreenStore((s) => s.svg);
  const close = useMermaidFullscreenStore((s) => s.close);
  return (
    <FullscreenDialog
      open={svg !== null}
      onClose={close}
      title={t("conversation.stream.mermaidFullscreen.diagram", "Diagram")}
    >
      {svg !== null && <MermaidDiagramView svg={svg} variant="fullscreen" onClose={close} />}
    </FullscreenDialog>
  );
}

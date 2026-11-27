import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useCallback } from "react";
import { LayoutDashboardIcon } from "lucide-react";
import { VisualChrome } from "@/components/visuals/VisualChrome";
import { VisualFrame } from "@/components/visuals/VisualFrame";
import { useVisualTheme } from "@/lib/visuals/live-theme";
import { openVisualFullscreen } from "@/stores/visual-fullscreen-store";

interface HtmlVisualProps {
  code: string;
  variant?: "inline" | "fullscreen";
  onEscape?: () => void;
}

/** A ` ```cadencr-html ` fence: the agent's visual, sandboxed, with its source one click away. */
const HtmlVisual = memo(function HtmlVisual({
  code,
  variant = "inline",
  onEscape,
}: HtmlVisualProps) {
  const { t } = useUiTranslation();
  const theme = useVisualTheme();
  const expand = useCallback(() => openVisualFullscreen({ kind: "cadencr-html", code }), [code]);
  // The sandbox shell takes one document per load, so a new theme (canvas
  // libraries bake colors in at draw time) or a new source gets a new frame.
  const frame = (
    <VisualFrame
      key={`${theme.key}\n${code}`}
      html={code}
      theme={theme}
      variant={variant}
      onEscape={onEscape}
    />
  );

  if (variant === "fullscreen") return frame;

  return (
    <VisualChrome
      label={t("conversation.stream.visual.visual", "Visual")}
      icon={<LayoutDashboardIcon className="size-3" />}
      code={code}
      sourceLanguage="html"
      onExpand={expand}
    >
      {frame}
    </VisualChrome>
  );
});

export default HtmlVisual;

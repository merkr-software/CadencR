import { memo } from "react";
import { LayoutDashboardIcon } from "lucide-react";
import { VisualChrome } from "@/components/visuals/VisualChrome";
import { VisualFrame } from "@/components/visuals/VisualFrame";
import { useVisualTheme } from "@/lib/visuals/live-theme";

interface HtmlVisualProps {
  code: string;
}

/** A ` ```cadencr-html ` fence: the agent's visual, sandboxed, with its source one click away. */
const HtmlVisual = memo(function HtmlVisual({ code }: HtmlVisualProps) {
  const theme = useVisualTheme();

  return (
    <VisualChrome
      label="Visual"
      icon={<LayoutDashboardIcon className="size-3" />}
      code={code}
      sourceLanguage="html"
    >
      {/* The sandbox shell takes one document per load, so a new theme (canvas
          libraries bake colors in at draw time) or a new source gets a new frame. */}
      <VisualFrame key={`${theme.key}\n${code}`} html={code} theme={theme} />
    </VisualChrome>
  );
});

export default HtmlVisual;

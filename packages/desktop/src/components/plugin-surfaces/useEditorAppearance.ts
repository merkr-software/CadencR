import { useEffect, useState } from "react";
import type { EditorAppearance } from "@cadencr/tab-sdk/protocol";
import { DEFAULT_MONO_STACK } from "@/lib/fonts/constants";

/** Read only the two appearance values guests need, on CSS mutations. */
function currentAppearance(): EditorAppearance {
  const style = getComputedStyle(document.documentElement);
  const size = style.getPropertyValue("--code-font-size").trim();
  const rootSize = Number.parseFloat(style.fontSize) || 16;
  const value = Number.parseFloat(size);
  const fontSize = size.endsWith("rem") ? value * rootSize : value;
  return {
    fontFamily: style.getPropertyValue("--font-mono").trim() || DEFAULT_MONO_STACK,
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 11.5,
  };
}

export function useEditorAppearance(): EditorAppearance {
  const [appearance, setAppearance] = useState(currentAppearance);
  useEffect(() => {
    let frame: number | null = null;
    const update = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const next = currentAppearance();
        setAppearance((previous) =>
          previous.fontFamily === next.fontFamily && previous.fontSize === next.fontSize
            ? previous
            : next,
        );
      });
    };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme"],
    });
    update();
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  return appearance;
}

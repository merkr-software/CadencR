import { StrictMode, useLayoutEffect } from "react";
import { useUiTranslation } from "@/lib/i18n/ui";
import { createRoot } from "react-dom/client";
import { NotchIsland } from "./NotchIsland";
import "./notch.css";
import "./notch-panel.css";
import "./notch-snooze.css";

function NotchRenderer() {
  const { t, i18n } = useUiTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("notch.windowTitle", "Cadencr Notch");
  }, [locale, t]);
  return <NotchIsland />;
}

const root = document.getElementById("notch-root");
if (!root) throw new Error("Missing #notch-root");
createRoot(root).render(
  <StrictMode>
    <NotchRenderer />
  </StrictMode>,
);

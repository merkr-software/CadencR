import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NotchIsland } from "./NotchIsland";
import "./notch.css";
import "./notch-panel.css";
import "./notch-snooze.css";

const root = document.getElementById("notch-root");
if (!root) throw new Error("Missing #notch-root");
createRoot(root).render(
  <StrictMode>
    <NotchIsland />
  </StrictMode>,
);

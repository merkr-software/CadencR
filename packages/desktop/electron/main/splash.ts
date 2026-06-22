import { BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import {
  parseStartupRecoveryActionUrl,
  type StartupRecoveryAction,
  type StartupRecoveryActionId,
} from "./startup-recovery";

// The splash loads from a data: URL before the renderer exists, so the brand
// font (Figtree — the "CADENCR" wordmark face) must be embedded inline rather
// than linked. @fontsource-variable/figtree is a runtime dependency, so it
// resolves from node_modules in dev and from the packaged app bundle (asar).
function loadFigtreeBase64(): string {
  try {
    const fontPath =
      require.resolve("@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2");
    return readFileSync(fontPath).toString("base64");
  } catch (error) {
    // Cosmetic only — the wordmark falls back to Inter/system. Never block boot
    // on a missing splash font, but surface why it fell back.
    console.warn("[splash] Figtree font unavailable; using fallback font:", error);
    return "";
  }
}
const FIGTREE_WOFF2_BASE64: string = loadFigtreeBase64();

const SPLASH_WIDTH = 520;
const SPLASH_HEIGHT = 400;
const ERROR_SPLASH_WIDTH = 640;
const ERROR_SPLASH_HEIGHT = 500;
const BACKGROUND = "#1e1e28";

export type SplashPhase =
  | "starting"
  | "starting_service"
  | "backing_up"
  | "backup_failed"
  | "migrating"
  | "loading_app";

interface PhaseCopy {
  title: string;
  detail: string;
}

type SplashUpdateKind = "phase" | "error";

interface PendingSplashUpdate {
  kind: SplashUpdateKind;
  title: string;
  detail: string;
  actions?: StartupRecoveryAction[];
}

export interface SplashErrorState {
  title: string;
  detail: string;
  actions?: StartupRecoveryAction[];
}

const PHASE_COPY: Record<SplashPhase, PhaseCopy> = {
  starting: { title: "Starting Cadencr", detail: "Preparing the workspace…" },
  starting_service: { title: "Starting Cadencr", detail: "Bringing up the backend service…" },
  backing_up: {
    title: "Backing up your database",
    detail: "Saving a snapshot before applying updates.",
  },
  backup_failed: {
    title: "Continuing without a backup",
    detail: "Pre-migration backup failed; updates will still be applied.",
  },
  migrating: {
    title: "Updating your database",
    detail: "Applying schema changes. This may take a moment.",
  },
  loading_app: { title: "Almost there", detail: "Loading your workspace…" },
};

export interface SplashHandle {
  window: BrowserWindow;
  setPhase: (phase: SplashPhase, detail?: string) => void;
  setError: (title: string, detail: string, actions?: StartupRecoveryAction[]) => void;
  /** Programmatic close (e.g. handing off to the main window). */
  close: () => void;
  /** Fired when the splash is dismissed by the user before main loaded. */
  onUserClose: (handler: () => void) => void;
  /** Fired when the user clicks an explicit recovery action. */
  onAction: (handler: (action: StartupRecoveryActionId) => void) => void;
}

function createSplashBrowserWindow(): BrowserWindow {
  return new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    backgroundColor: BACKGROUND,
    title: "Cadencr",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

export function createSplashWindow(version: string): SplashHandle {
  const win = createSplashBrowserWindow();

  const html = renderSplashHtml(version);
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.once("ready-to-show", () => win.show());

  let closed = false;
  let domReady = false;
  let programmaticClose = false;
  let userCloseHandler: (() => void) | null = null;
  let actionHandler: ((action: StartupRecoveryActionId) => void) | null = null;
  let pending: PendingSplashUpdate | null = null;

  win.on("closed", () => {
    closed = true;
    if (!programmaticClose) userCloseHandler?.();
  });
  win.webContents.on("will-navigate", (event, url) => {
    const action = parseStartupRecoveryActionUrl(url);
    if (!action) return;
    event.preventDefault();
    actionHandler?.(action);
  });
  win.webContents.once("did-finish-load", () => {
    domReady = true;
    if (pending) {
      runUpdate(pending);
      pending = null;
    }
  });

  const runUpdate = (update: PendingSplashUpdate): void => {
    if (closed || win.isDestroyed()) return;
    void executeSplashUpdate(win, update, () => closed);
  };

  const update = (
    kind: SplashUpdateKind,
    title: string,
    detail: string,
    actions?: StartupRecoveryAction[],
  ): void => {
    if (closed) return;
    const next = { kind, title, detail, actions };
    if (!domReady) {
      pending = next;
      return;
    }
    runUpdate(next);
  };

  return {
    window: win,
    setPhase(phase, detail) {
      const copy = PHASE_COPY[phase];
      update("phase", copy.title, detail ?? copy.detail, []);
    },
    setError(title, detail, actions) {
      update("error", title, detail, actions);
    },
    close() {
      programmaticClose = true;
      if (!closed && !win.isDestroyed()) win.close();
    },
    onUserClose(handler) {
      userCloseHandler = handler;
    },
    onAction(handler) {
      actionHandler = handler;
    },
  };
}

async function executeSplashUpdate(
  win: BrowserWindow,
  update: PendingSplashUpdate,
  isClosed: () => boolean,
): Promise<void> {
  resizeSplashForKind(win, update.kind);
  const titleLit = JSON.stringify(update.title);
  const detailLit = JSON.stringify(update.detail);
  const actionsLit = JSON.stringify(renderActionHtml(update.actions ?? []));
  const errorClass = update.kind === "error" ? "add" : "remove";
  const script = `(function(){
    var t = document.getElementById("title");
    if (t) t.textContent = ${titleLit};
    var d = document.getElementById("detail");
    if (d) d.textContent = ${detailLit};
    var a = document.getElementById("actions");
    if (a) a.innerHTML = ${actionsLit};
    document.body.classList.${errorClass}("error");
  })();`;
  try {
    await win.webContents.executeJavaScript(script, true);
  } catch (error) {
    // Window can race with close; avoid crashing the main process.
    if (!isClosed()) console.warn("splash update failed", error);
  }
}

function resizeSplashForKind(win: BrowserWindow, kind: SplashUpdateKind): void {
  const width = kind === "error" ? ERROR_SPLASH_WIDTH : SPLASH_WIDTH;
  const height = kind === "error" ? ERROR_SPLASH_HEIGHT : SPLASH_HEIGHT;
  const [currentWidth, currentHeight] = win.getSize();
  if (currentWidth === width && currentHeight === height) return;

  win.setSize(width, height);
  win.center();
}

function renderSplashStyles(): string {
  const figtreeFace = FIGTREE_WOFF2_BASE64
    ? `@font-face {
    font-family: "Figtree Variable";
    font-weight: 300 900;
    font-display: block;
    src: url("data:font/woff2;base64,${FIGTREE_WOFF2_BASE64}") format("woff2");
  }`
    : "";
  return `
  ${figtreeFace}
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: ${BACKGROUND};
    color: #e8e6f3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none; cursor: default;
    overflow: hidden;
  }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 28px 32px;
  }
  .logo { width: 120px; height: 120px; margin-bottom: 18px; }
  .name {
    font-family: "Figtree Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 28px; font-weight: 800; letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #f8f8f2; margin-bottom: 4px;
  }
  .version { font-size: 11px; color: #6c6890; margin-bottom: 22px; }
  .title {
    font-size: 14px; font-weight: 500; color: #f8f8f2;
    margin-bottom: 6px; text-align: center;
  }
  .detail {
    font-size: 12px; color: #a59fc4;
    text-align: center; min-height: 32px; line-height: 1.4;
    max-width: 100%; max-height: 96px;
    overflow-y: auto; overflow-x: hidden;
    word-break: break-word;
    padding: 0 6px;
  }
  body.error { padding: 30px 36px; }
  body.error .logo { width: 96px; height: 96px; margin-bottom: 12px; }
  body.error .version { margin-bottom: 18px; }
  body.error .detail { max-height: 150px; }
  .detail::-webkit-scrollbar { width: 6px; }
  .detail::-webkit-scrollbar-thumb { background: #3a3754; border-radius: 9999px; }
  .actions {
    display: none; gap: 8px; justify-content: center; flex-wrap: wrap;
    margin-top: 18px; max-width: 100%;
  }
  body.error .actions { display: flex; }
  .action {
    appearance: none; border: 1px solid #3a3754; border-radius: 10px;
    padding: 8px 12px; color: #e8e6f3; background: #28263a;
    text-decoration: none; font-size: 12px; font-weight: 600;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .action:hover { background: #332f48; border-color: #5b5374; }
  .action.primary { background: #bd93f9; border-color: #bd93f9; color: #1e1e28; }
  .action.danger { border-color: #ff5555; color: #ffb3b3; }
  .spinner {
    width: 28px; height: 28px; border-radius: 50%;
    border: 2px solid #3a3754; border-top-color: #bd93f9;
    animation: spin 0.9s linear infinite;
    margin-top: 18px;
  }
  body.error .spinner { display: none; }
  body.error .title { color: #ff5555; }
  body.error .detail { color: #ffb3b3; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;
}

export function renderSplashHtml(version: string, initialError?: SplashErrorState): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Cadencr</title>
<style>
${renderSplashStyles()}
</style>
</head>
<body${initialError ? ' class="error"' : ""}>
  <svg class="logo" viewBox="0 0 1024 1024" aria-hidden="true">
    <g transform="translate(512 512) scale(8.24) translate(-50 -50)">
      <circle cx="50" cy="50" r="16" fill="#b388ff"/>
      <g transform="rotate(-90 50 50)">
        <circle cx="50" cy="50" r="28" pathLength="360" stroke="#454f63" stroke-width="5" stroke-linecap="round" stroke-dasharray="10 20" fill="none"/>
        <circle cx="50" cy="50" r="28" pathLength="360" stroke="#b2ff59" stroke-width="5" stroke-linecap="round" stroke-dasharray="40 320" fill="none" transform="rotate(240 50 50)"/>
        <circle cx="50" cy="50" r="28" pathLength="360" stroke="#80d8ff" stroke-width="5" stroke-linecap="round" stroke-dasharray="40 320" fill="none" transform="rotate(60 50 50)"/>
      </g>
    </g>
  </svg>
  <div class="name">Cadencr</div>
  <div class="version">v${escapeHtml(version)}</div>
  <div class="title" id="title">${escapeHtml(initialError?.title ?? "Starting Cadencr")}</div>
  <div class="detail" id="detail">${escapeHtml(initialError?.detail ?? "Preparing the workspace…")}</div>
  <div class="actions" id="actions">${renderActionHtml(initialError?.actions ?? [])}</div>
  <div class="spinner" id="spinner"></div>
</body>
</html>`;
}

function renderActionHtml(actions: StartupRecoveryAction[]): string {
  return actions
    .map((action) => {
      const classes = ["action", action.primary ? "primary" : "", action.danger ? "danger" : ""]
        .filter(Boolean)
        .join(" ");
      const href = `cadencr-splash://action/${encodeURIComponent(action.id)}`;
      return `<a class="${classes}" href="${href}">${escapeHtml(action.label)}</a>`;
    })
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

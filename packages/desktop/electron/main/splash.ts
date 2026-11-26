import { app, BrowserWindow, dialog } from "electron";
import { readFileSync } from "node:fs";
import {
  EMERALD,
  GROUND as BACKGROUND,
  HAIRLINE,
  INK,
  RAISED,
  ringDots,
  SOFT as MUTED,
  STANDARD_CUT,
} from "@cadencr/brand";
import { type StartupRecoveryAction, type StartupRecoveryActionId } from "./startup-recovery";
import { splashProgressDetail } from "./splash-progress";
import { matchSystemLocale } from "../../src/lib/i18n/languages";
import { changeUiLanguage, uiI18n } from "../../src/shared/ui-i18n";
import { splashCopyForPhase, type SplashPhase } from "./splash-copy";
import { windowIconOption } from "./app-icon";
import { secureSplashWebContents } from "./splash-security";

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
    ...windowIconOption({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

/** Before the service and its saved preference are available, use the OS preference. */
export async function initializeStartupLanguage(): Promise<void> {
  try {
    await changeUiLanguage(matchSystemLocale(app.getPreferredSystemLanguages()));
  } catch (error) {
    dialog.showErrorBox(app.getName(), error instanceof Error ? error.message : String(error));
  }
}

export function createSplashWindow(version: string): SplashHandle {
  const win = createSplashBrowserWindow();
  secureSplashWebContents(win.webContents, (action) => actionHandler?.(action));
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
      const copy = splashCopyForPhase(phase);
      update("phase", copy.title, splashProgressDetail(detail) ?? copy.detail, []);
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
    color: ${INK};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none; cursor: default;
    overflow: hidden;
  }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 28px 32px;
  }
  .logo { width: 112px; height: 112px; margin-bottom: 18px; }
  /* While loading, the twelve index dots pulse in sequence — the mark itself
   * is the activity indicator. The pulse stops in the error state. */
  .logo .d {
    animation: dot-pulse 1.8s ease-in-out infinite;
  }
  body.error .logo .d { animation: none; opacity: 1; }
  @keyframes dot-pulse {
    0%, 100% { opacity: 0.3; }
    16% { opacity: 1; }
    40% { opacity: 0.3; }
  }
  @media (prefers-reduced-motion: reduce) {
    .logo .d { animation: none; opacity: 1; }
  }
  .name {
    font-family: "Figtree Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 26px; font-weight: 800; letter-spacing: 0.18em;
    text-transform: uppercase;
    color: ${INK}; margin-bottom: 4px;
  }
  .version { font-size: 11px; color: #6e7176; margin-bottom: 22px; }
  .title {
    font-size: 14px; font-weight: 500; color: ${INK};
    margin-bottom: 6px; text-align: center;
  }
  .detail {
    font-size: 12px; color: ${MUTED};
    text-align: center; min-height: 32px; line-height: 1.4;
    max-width: 100%; max-height: 96px;
    overflow-y: auto; overflow-x: hidden;
    word-break: break-word;
    padding: 0 6px;
  }
  body.error { padding: 30px 36px; }
  body.error .logo { width: 88px; height: 88px; margin-bottom: 12px; }
  body.error .version { margin-bottom: 18px; }
  body.error .detail { max-height: 150px; }
  .detail::-webkit-scrollbar { width: 6px; }
  .detail::-webkit-scrollbar-thumb { background: ${HAIRLINE}; border-radius: 9999px; }
  .actions {
    display: none; gap: 8px; justify-content: center; flex-wrap: wrap;
    margin-top: 18px; max-width: 100%;
  }
  body.error .actions { display: flex; }
  .action {
    appearance: none; border: 1px solid ${HAIRLINE}; border-radius: 8px;
    padding: 8px 12px; color: ${INK}; background: ${RAISED};
    text-decoration: none; font-size: 12px; font-weight: 600;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .action:hover { background: #202124; border-color: #4a4d50; }
  .action.primary { background: ${EMERALD}; border-color: ${EMERALD}; color: ${BACKGROUND}; }
  .action.primary:hover { background: #279f70; border-color: #279f70; }
  .action.danger { border-color: #ec707b; color: #ff9da6; }
  body.error .title { color: #ec707b; }
  body.error .detail { color: #e6a8ae; }
`;
}

/** The Index Dots mark: twelve dots on a r14.5 ring around an emerald core on a
 *  48 grid (root DESIGN.md "Brand identity"). Each dot carries a staggered
 *  animation delay so the pulse travels around the ring while loading. */
function renderLogoSvg(): string {
  const dots = ringDots()
    .map(
      ({ cx, cy }, i) =>
        `<circle class="d" cx="${cx}" cy="${cy}" r="${STANDARD_CUT.dotR}" style="animation-delay:${i * 150}ms"/>`,
    )
    .join("");
  return `<svg class="logo" viewBox="0 0 48 48" aria-hidden="true">
    <g fill="${INK}">${dots}</g>
    <circle cx="24" cy="24" r="${STANDARD_CUT.coreR}" fill="${EMERALD}"/>
  </svg>`;
}

export function renderSplashHtml(version: string, initialError?: SplashErrorState): string {
  const copy = initialError ?? splashCopyForPhase("starting");
  return `<!doctype html>
<html lang="${escapeHtml(uiI18n.resolvedLanguage ?? uiI18n.language)}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'" />
<title>Cadencr</title>
<style>
${renderSplashStyles()}
</style>
</head>
<body${initialError ? ' class="error"' : ""}>
  ${renderLogoSvg()}
  <div class="name">Cadencr</div>
  <div class="version">v${escapeHtml(version)}</div>
  <div class="title" id="title">${escapeHtml(copy.title)}</div>
  <div class="detail" id="detail" role="status" aria-live="polite">${escapeHtml(copy.detail)}</div>
  <div class="actions" id="actions">${renderActionHtml(initialError?.actions ?? [])}</div>
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

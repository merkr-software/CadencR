// Minimal Chrome DevTools Protocol client for one QA run's renderer page:
// raw WebSocket (built into Node 22), no Playwright, one session per command.
// Parallel runs each talk to their own CDP port, unlike the chrome-devtools MCP
// whose single shared browser profile cannot be driven by two QAs at once.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Longest a single command may take; an `eval` that polls the page must finish within it. */
const COMMAND_TIMEOUT_MS = 180_000;

export async function listTargets(cdpPort) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`CDP /json/list answered ${response.status}`);
  return response.json();
}

/**
 * The app's main window: a `page` target served by this run's renderer at `/`
 * (any hash route). Not the notch island (`/notch.html`), a guest view or devtools.
 */
export function pickRendererTarget(targets, rendererUrl) {
  const isMainPage = (url) => {
    if (!url.startsWith(rendererUrl)) return false;
    const { pathname } = new URL(url);
    return pathname === "/" || pathname === "/index.html";
  };
  return targets.find((target) => target.type === "page" && isMainPage(target.url)) ?? null;
}

export async function openSession(cdpPort, rendererUrl) {
  const target = pickRendererTarget(await listTargets(cdpPort), rendererUrl);
  if (!target) throw new Error(`no page from ${rendererUrl} on CDP port ${cdpPort}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const settle = (id) => {
    const waiter = pending.get(id);
    pending.delete(id);
    if (waiter) clearTimeout(waiter.timer);
    return waiter;
  };
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = settle(message.id);
    if (!waiter) return;
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  });
  // A crashed or reloaded page closes the socket: fail every pending command
  // instead of hanging (or exiting 0 with no output).
  socket.addEventListener("close", () => {
    for (const id of [...pending.keys()]) {
      settle(id)?.reject(new Error("CDP socket closed (page reloaded or app exited)"));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      // A closed socket drops sends silently: fail now, not after the timeout.
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error(`${method}: CDP socket closed (page reloaded or app exited)`));
        return;
      }
      nextId += 1;
      const id = nextId;
      const timer = setTimeout(() => {
        settle(id)?.reject(new Error(`${method}: no answer within ${COMMAND_TIMEOUT_MS / 1000}s`));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, method, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  // An occluded dev window reports `hidden`: exit animations never finish and a
  // closed Radix popover dismisses the next one. Front + focus emulation in the
  // same session as the interactions avoids those false regressions.
  await send("Page.bringToFront");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return { target, send, close: () => socket.close() };
}

export async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`page threw: ${detail}`);
  }
  return result.result.value;
}

/** Centre of the first element matching a CSS selector, or `text=…` for visible text. */
function locateExpression(locator) {
  const byText = locator.startsWith("text=");
  const needle = JSON.stringify(byText ? locator.slice(5) : locator);
  const find = byText
    ? `[...document.querySelectorAll("button,a,[role],input,textarea,label,span,div")]
        .filter((el) => el.offsetParent !== null && el.textContent.trim() === ${needle})
        .at(-1)`
    : `document.querySelector(${needle})`;
  return `(() => { const el = ${find}; if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
}

/** A real mouse click (Radix ignores synthetic `el.click()` for some triggers). */
export async function click(session, locator) {
  const point = await evaluate(session, locateExpression(locator));
  if (!point) throw new Error(`nothing matches ${locator}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await session.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  }
  return point;
}

export async function typeText(session, text) {
  await session.send("Input.insertText", { text });
}

const KEY_CODES = {
  Enter: ["Enter", 13],
  Escape: ["Escape", 27],
  Tab: ["Tab", 9],
  Backspace: ["Backspace", 8],
  Delete: ["Delete", 46],
  ArrowUp: ["ArrowUp", 38],
  ArrowDown: ["ArrowDown", 40],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowRight: ["ArrowRight", 39],
};

/** DOM `code` and virtual key code for a key name, so default actions (Tab, arrows) happen too. */
export function keyDescriptor(key) {
  if (KEY_CODES[key]) return { code: KEY_CODES[key][0], keyCode: KEY_CODES[key][1] };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, keyCode: key.charCodeAt(0) };
  if (/^[a-z]$/i.test(key))
    return { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
  return { code: key, keyCode: 0 };
}

export async function pressKey(session, key) {
  const { code, keyCode } = keyDescriptor(key);
  for (const type of ["keyDown", "keyUp"]) {
    await session.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });
  }
}

export async function screenshot(session, file) {
  const { data } = await session.send("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

export function defaultScreenshotPath(layout, name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(layout.screenshots, `${name ?? stamp}.png`);
}

/**
 * Whether React has mounted the app and painted something. Not "`#root` has
 * children": a blocking modal (telemetry decision, onboarding) renders in a
 * portal beside an empty `#root`.
 */
export const APP_MOUNTED_EXPRESSION = `(() => {
  const root = document.querySelector("#root");
  const mounted = !!root && Object.keys(root).some((key) => key.startsWith("__reactContainer$"));
  return document.readyState === "complete" && mounted && document.body.innerText.trim().length > 0;
})()`;

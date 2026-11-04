import { connect, type EditorAppearance } from "@cadencr/tab-sdk";
import "./style.css";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element ${id}`);
  return found as T;
}

const status = element("status");
const error = element("error");
const open = element<HTMLButtonElement>("open");
const snapshot = element<HTMLButtonElement>("snapshot");
const result = element("result");

function showError(failure: unknown): void {
  error.textContent = failure instanceof Error ? failure.message : String(failure);
}

function applyAppearance(appearance: EditorAppearance | null): void {
  element("appearance").textContent = appearance
    ? `${appearance.fontFamily} / ${appearance.fontSize}px`
    : "Host did not provide editor appearance";
  if (appearance) {
    result.style.fontFamily = appearance.fontFamily;
    result.style.fontSize = `${appearance.fontSize}px`;
  }
}

async function start(): Promise<void> {
  const client = await connect();
  client.onError(showError);
  element("surface").textContent = `${client.surface.kind} / ${client.surface.instanceId}`;
  const visibility = (visible: boolean): void => {
    element("visible").textContent = String(visible);
  };
  const focus = (focused: boolean): void => {
    element("focused").textContent = String(focused);
  };
  visibility(client.visible);
  focus(client.focused);
  applyAppearance(client.editorAppearance);
  client.onVisibilityChange(visibility);
  client.onFocusChange(focus);
  client.onEditorAppearanceChange(applyAppearance);
  client.onConnectionChange((connected) => {
    status.textContent = connected ? "Connected" : "Disconnected";
  });
  const request = async (method: string): Promise<void> => {
    open.disabled = snapshot.disabled = true;
    status.textContent = "Waiting for the editor…";
    try {
      const value = await client.backend.request(
        method,
        method === "editor.open"
          ? {
              path: element<HTMLInputElement>("path").value,
              line: 12,
              column: 3,
            }
          : undefined,
      );
      result.textContent = JSON.stringify(value, null, 2);
      status.textContent = "Acknowledged";
    } catch (failure) {
      showError(failure);
      status.textContent = "Request failed";
    } finally {
      open.disabled = snapshot.disabled = false;
    }
  };
  open.addEventListener("click", () => {
    void request("editor.open");
  });
  snapshot.addEventListener("click", () => {
    void request("snapshot");
  });
  status.textContent = "Connected";
  open.disabled = snapshot.disabled = false;
}

void start().catch(showError);

import { connect, toCadencrError, type BackendSubscription } from "@cadencr/tab-sdk";
import "./style.css";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing ${id}`);
  return node as T;
}

const status = element("status");
const lastError = element("error");
const tick = element("tick");
const process = element("process");
const resyncs = element("resyncs");
const snapshotButton = element<HTMLButtonElement>("snapshot");
const unsubscribeButton = element<HTMLButtonElement>("unsubscribe");
let subscription: BackendSubscription | null = null;
let resyncCount = 0;

function failure(error: unknown): void {
  const problem = toCadencrError(error);
  status.textContent = "Failed";
  lastError.textContent = `Last error: ${problem.code}: ${problem.message}`;
}

async function start(): Promise<void> {
  const client = await connect();
  client.onError(failure);
  const snapshot = async () => {
    snapshotButton.disabled = true;
    status.textContent = "Reading snapshot…";
    try {
      const result = await client.backend.request<{ tick?: unknown }>("snapshot");
      if (
        result === null ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        typeof result.tick !== "number"
      )
        throw new Error("Invalid clock snapshot");
      tick.textContent = String(result.tick);
      status.textContent = "Listening";
    } catch (error) {
      failure(error);
    } finally {
      snapshotButton.disabled = false;
    }
  };
  snapshotButton.onclick = () => void snapshot();
  unsubscribeButton.onclick = () => {
    subscription?.unsubscribe();
    subscription = null;
    status.textContent = "Unsubscribed";
    unsubscribeButton.disabled = true;
  };
  subscription = await client.backend.subscribe(
    "clock.tick",
    (event) => {
      process.textContent = event.runId;
      const value = event.payload;
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.tick === "number"
      )
        tick.textContent = String(value.tick);
      status.textContent = "Listening";
    },
    {
      onResync: () => {
        resyncs.textContent = String(++resyncCount);
        void snapshot();
      },
      onError: failure,
    },
  );
  // Registration is acknowledged before the background producer attaches.
  await client.backend.request("start");
  unsubscribeButton.disabled = false;
  snapshotButton.disabled = false;
}

void start().catch(failure);

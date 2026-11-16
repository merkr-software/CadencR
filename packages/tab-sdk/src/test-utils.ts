import { connect, type ConnectOptions } from "./connect.js";
import { createTestHost, type TestHost, type TestHostOptions } from "./testing/index.js";
import type { CadencrClient } from "./client.js";

export async function connected(
  hostOptions: TestHostOptions = {},
  connectOptions: ConnectOptions = {},
): Promise<{ host: TestHost; client: CadencrClient }> {
  const host = createTestHost(hostOptions);
  const client = await connect({ transport: host.transport, ...connectOptions });
  return { host, client };
}

/** Lets queued port messages and microtasks run. */
export function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

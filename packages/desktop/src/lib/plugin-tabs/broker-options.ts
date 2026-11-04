import type {
  EditorAppearance,
  SurfaceIdentity,
  TabContext,
  ThemeSnapshot,
} from "@cadencr/tab-sdk/protocol";
import type { BackendFailureDeps } from "./broker-backend-failures";
import type { GrantDeps } from "./broker-grant";
import type { FetchLike } from "./broker-http";
import type { PluginIdentity } from "./broker-runtime";
import type { SocketFactory } from "./broker-streams";

export interface PluginTabBrokerOptions {
  instanceId: string;
  featureId: number;
  plugin: PluginIdentity;
  context: TabContext;
  visible: boolean;
  surface?: SurfaceIdentity;
  appearance?: EditorAppearance;
}

/** Host-only seams; none is accessible from a guest's MessagePort. */
export interface PluginTabBrokerDeps {
  grant?: GrantDeps;
  backendFailures?: BackendFailureDeps;
  fetch?: FetchLike;
  socket?: SocketFactory;
  theme?: () => ThemeSnapshot;
  windowPorts?: boolean;
  connectionChanged?: (connected: boolean) => void;
}

import type { PendingPermission } from "@/types/agent-permission";

interface PendingPermissionQueueState {
  pendingPermission: PendingPermission | null;
  pendingPermissionQueue?: PendingPermission[];
}

interface PendingPermissionQueuePatch {
  pendingPermission: PendingPermission | null;
  pendingPermissionQueue: PendingPermission[];
}

function permissionQueueKey(permission: PendingPermission): string {
  return (
    permission.requestId ??
    `${permission.toolName}:${permission.pattern}:${permission.preview ?? ""}`
  );
}

export function upsertPendingPermission(
  state: PendingPermissionQueueState,
  permission: PendingPermission,
): PendingPermissionQueuePatch {
  const current = state.pendingPermission;
  const queue = (state.pendingPermissionQueue ?? []).filter(
    (candidate) => permissionQueueKey(candidate) !== permissionQueueKey(permission),
  );
  if (!current) return { pendingPermission: permission, pendingPermissionQueue: queue };
  if (permissionQueueKey(current) === permissionQueueKey(permission)) {
    return { pendingPermission: permission, pendingPermissionQueue: queue };
  }
  return { pendingPermission: current, pendingPermissionQueue: [...queue, permission] };
}

export function advancePendingPermissionQueue(
  queue: PendingPermission[],
): PendingPermissionQueuePatch {
  const [pendingPermission, ...pendingPermissionQueue] = queue;
  return { pendingPermission: pendingPermission ?? null, pendingPermissionQueue };
}

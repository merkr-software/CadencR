export type PermissionDecisionValue = "allow_once" | "allow_future" | "deny";

export interface PermissionOption {
  decision: PermissionDecisionValue;
  optionId?: string;
  label: string;
  description: string;
  collectFeedback?: boolean;
}

export interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  pattern: string;
  preview?: string;
  options?: PermissionOption[];
  requestId?: string;
}

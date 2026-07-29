export const PluginApprovalResolutions = {
  ALLOW_ONCE: "allow-once",
  ALLOW_ALWAYS: "allow-always",
  DENY: "deny",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
} as const;

export type PluginApprovalResolution =
  (typeof PluginApprovalResolutions)[keyof typeof PluginApprovalResolutions];

export type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    /** Override timeout text and return the timeout as a blocked tool result. */
    timeoutReason?: string;
    /** Return this text when the approval is registered and this tool call must be retried. */
    pendingReason?: string;
    allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
    /**
     * Let a later identical approval request consume a resolved decision.
     * Use for lifecycle tools whose visible approval may outlive the agent/tool
     * call that created it.
     */
    replayLateDecision?: boolean;
    /** Register the approval prompt, then block this call so a later retry consumes the decision. */
    deferUntilRetry?: boolean;
    pluginId?: string;
    onResolution?: (decision: PluginApprovalResolution) => Promise<void> | void;
  };
};

import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  normalizeExecAsk,
  normalizeExecMode,
  normalizeExecSecurity,
  normalizeExecTarget,
  resolveExecPolicyForMode,
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
} from "../../infra/exec-approvals.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { hasRejectedExecDirective } from "./directive-handling.shared.js";

export type ReplyExecOverrides = Pick<
  ExecToolDefaults,
  "host" | "mode" | "security" | "ask" | "node"
>;

export function resolveReplyExecOverrides(params: {
  directives: InlineDirectives;
  sessionEntry?: SessionEntry;
  globalExecDefaults?: ReplyExecOverrides;
  agentExecDefaults?: ReplyExecOverrides;
}): ReplyExecOverrides | undefined {
  const directives = hasRejectedExecDirective(params.directives)
    ? {
        ...params.directives,
        execHost: undefined,
        execMode: undefined,
        execSecurity: undefined,
        execAsk: undefined,
        execNode: undefined,
      }
    : params.directives;
  const host =
    directives.execHost ??
    normalizeExecTarget(params.sessionEntry?.execHost) ??
    params.agentExecDefaults?.host ??
    params.globalExecDefaults?.host;
  const globalPolicy = materializeExecPolicy(params.globalExecDefaults);
  const agentPolicy = applyExecPolicyLayer(
    globalPolicy,
    materializeExecPolicy(params.agentExecDefaults),
  );
  const sessionPolicy = applyExecPolicyLayer(agentPolicy, {
    mode: normalizeExecMode(params.sessionEntry?.execMode) ?? undefined,
    security: normalizeExecSecurity(params.sessionEntry?.execSecurity) ?? undefined,
    ask: normalizeExecAsk(params.sessionEntry?.execAsk) ?? undefined,
  });
  const policy = applyExecPolicyLayer(sessionPolicy, {
    mode: directives.execMode,
    security: directives.execSecurity,
    ask: directives.execAsk,
  });
  const node =
    directives.execNode ??
    params.sessionEntry?.execNode ??
    params.agentExecDefaults?.node ??
    params.globalExecDefaults?.node;
  const mode = policy.mode;
  const security = mode ? undefined : policy.security;
  const ask = mode ? undefined : policy.ask;
  if (!host && !mode && !security && !ask && !node) {
    return undefined;
  }
  return { host, mode, security, ask, node };
}

function materializeExecPolicy(exec?: ReplyExecOverrides): {
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
} {
  if (exec?.mode) {
    const modePolicy = resolveExecPolicyForMode(exec.mode);
    return {
      mode: exec.mode,
      security: modePolicy.security,
      ask: modePolicy.ask,
    };
  }
  return {
    security: exec?.security,
    ask: exec?.ask,
  };
}

function applyExecPolicyLayer(
  base: { mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk },
  layer: { mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk },
): { mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk } {
  if (layer.mode) {
    const policy = resolveExecPolicyForMode(layer.mode);
    return {
      mode: layer.mode,
      security: policy.security,
      ask: policy.ask,
    };
  }
  if (layer.security !== undefined || layer.ask !== undefined) {
    return {
      security: layer.security ?? base.security,
      ask: layer.ask ?? base.ask,
    };
  }
  return base;
}

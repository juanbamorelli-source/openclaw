/**
 * Prompt-surface helpers for OpenClaw tool guidance.
 *
 * Maps runtime/session surfaces to the fallback tool text and workflow hints that belong in prompts.
 */
import { isOpenClawMainPromptSurface } from "../plugins/agent-prompt-surface-kind.js";
import type { AgentPromptSurfaceKind } from "../plugins/types.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";

/** Builds fallback tool guidance when a runtime cannot render the structured tool list. */
export function buildOpenClawToolFallbackText(params: {
  surface: AgentPromptSurfaceKind;
  execToolName: string;
  processToolName: string;
}): string {
  if (isOpenClawMainPromptSurface(params.surface)) {
    return [
      "OpenClaw lists the standard tools above. This runtime enables:",
      "- grep: search file contents for patterns",
      "- find: find files by glob pattern",
      "- ls: list directory contents",
      "- apply_patch: apply multi-file patches",
      `- ${params.execToolName}: run shell commands (supports background via yieldMs/background)`,
      `- ${params.processToolName}: manage background exec sessions`,
      "- browser: control OpenClaw's dedicated browser",
      "- canvas: present/eval/snapshot the Canvas",
      "- nodes: list/describe/notify/camera/screen on paired nodes",
      "- cron: manage cron jobs and wake events (use for reminders; when scheduling a reminder, write the systemEvent text as something that will read like a reminder when it fires, and mention that it is a reminder depending on the time gap between setting and firing; include recent context in reminder text if appropriate)",
      "- sessions_list: list sessions",
      "- sessions_history: fetch session history",
      "- sessions_send: send to another session",
      "- sessions_spawn: spawn an isolated sub-agent session",
      "- sessions_yield: end this turn and wait for sub-agent completion events",
      "- subagents: list active/recent sub-agent runs",
      '- session_status: show usage/time/model state and answer "what model are we using?"',
    ].join("\n");
  }

  if (params.surface === "openclaw_chat") {
    return [
      "OpenClaw lists the standard tools above. This lightweight chat prompt enables only the tools exposed directly by the active backend.",
      `Use ${params.execToolName} for local read-only checks when needed; use first-class tools when listed.`,
      "Use `sessions_spawn` only for clearly bounded delegated work.",
      "Do not assume hidden tools exist.",
    ].join("\n");
  }

  return "No OpenClaw tool list is injected for this runtime prompt surface. Use only tools exposed directly by the active backend.";
}

/** Returns whether the main OpenClaw prompt should include workflow hints around the tool list. */
export function shouldRenderOpenClawToolWorkflowHints(params: {
  surface: AgentPromptSurfaceKind;
  hasToolList: boolean;
}): boolean {
  return isOpenClawMainPromptSurface(params.surface);
}

function isDiscordChannelSessionKey(sessionKey?: string): boolean {
  const rest = parseAgentSessionKey(sessionKey)?.rest;
  return rest?.startsWith("discord:") === true;
}

/** Maps a session key to the prompt surface used for tool guidance and runtime behavior. */
export function resolveAgentPromptSurfaceForSessionKey(
  sessionKey?: string,
): AgentPromptSurfaceKind {
  if (sessionKey && isAcpSessionKey(sessionKey)) {
    return "acp_backend";
  }
  if (sessionKey && isSubagentSessionKey(sessionKey)) {
    return "subagent";
  }
  return isDiscordChannelSessionKey(sessionKey) ? "openclaw_chat" : "openclaw_main";
}

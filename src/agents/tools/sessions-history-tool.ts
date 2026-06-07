/**
 * sessions_history built-in tool.
 *
 * Reads bounded, redacted session transcript history after session visibility filtering.
 */
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { capArrayByJsonBytes } from "../../gateway/session-utils.fs.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { truncateUtf16Safe } from "../../utils.js";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";
import {
  describeSessionsHistoryTool,
  SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readPositiveIntegerParam, readStringParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSandboxedSessionToolContext,
  resolveVisibleSessionReference,
  stripToolMessages,
} from "./sessions-helpers.js";

const SessionsHistoryToolSchema = Type.Object({
  sessionKey: Type.String(),
  limit: optionalPositiveIntegerSchema(),
  includeTools: Type.Optional(Type.Boolean()),
});

const SESSIONS_HISTORY_MAX_BYTES = 80 * 1024;
const SESSIONS_HISTORY_WITH_TOOLS_MAX_BYTES = 24 * 1024;
const SESSIONS_HISTORY_TEXT_MAX_CHARS = 4000;
const SESSIONS_HISTORY_TOOL_TEXT_MAX_CHARS = 1200;
const SESSIONS_HISTORY_WITH_TOOLS_MIN_BYTES = 1024;
const SESSIONS_HISTORY_WITH_TOOLS_MAX_CONFIG_BYTES = 1024 * 1024;
const SESSIONS_HISTORY_TOOL_TEXT_MIN_CHARS = 100;
const SESSIONS_HISTORY_TOOL_TEXT_MAX_CONFIG_CHARS = 50_000;
type GatewayCaller = typeof callGateway;

// sandbox policy handling is shared with sessions-list-tool via sessions-helpers.ts

function truncateHistoryText(text: string): {
  text: string;
  truncated: boolean;
  redacted: boolean;
} {
  // sessions_history is a tool surface, not a log sink. Keep it redacted even
  // when operators disable general-purpose log redaction.
  const sanitized = redactToolPayloadText(text);
  const redacted = sanitized !== text;
  if (sanitized.length <= SESSIONS_HISTORY_TEXT_MAX_CHARS) {
    return { text: sanitized, truncated: false, redacted };
  }
  const cut = truncateUtf16Safe(sanitized, SESSIONS_HISTORY_TEXT_MAX_CHARS);
  return { text: `${cut}\n…(truncated)…`, truncated: true, redacted };
}

function readBoundedPositiveInteger(
  value: unknown,
  params: {
    fallback: number;
    min: number;
    max: number;
  },
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return params.fallback;
  }
  return Math.min(params.max, Math.max(params.min, value));
}

function resolveSessionsHistoryLimits(cfg: OpenClawConfig): {
  includeToolsMaxBytes: number;
  toolResultMaxChars: number;
} {
  const historyCfg = cfg.tools?.sessions?.history;
  return {
    includeToolsMaxBytes: readBoundedPositiveInteger(historyCfg?.includeToolsMaxBytes, {
      fallback: SESSIONS_HISTORY_WITH_TOOLS_MAX_BYTES,
      min: SESSIONS_HISTORY_WITH_TOOLS_MIN_BYTES,
      max: SESSIONS_HISTORY_WITH_TOOLS_MAX_CONFIG_BYTES,
    }),
    toolResultMaxChars: readBoundedPositiveInteger(historyCfg?.toolResultMaxChars, {
      fallback: SESSIONS_HISTORY_TOOL_TEXT_MAX_CHARS,
      min: SESSIONS_HISTORY_TOOL_TEXT_MIN_CHARS,
      max: SESSIONS_HISTORY_TOOL_TEXT_MAX_CONFIG_CHARS,
    }),
  };
}

function sanitizeHistoryContentBlock(block: unknown): {
  block: unknown;
  truncated: boolean;
  redacted: boolean;
} {
  if (!block || typeof block !== "object") {
    return { block, truncated: false, redacted: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let truncated = false;
  let redacted = false;
  const type = typeof entry.type === "string" ? entry.type : "";
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (type === "thinking") {
    if (typeof entry.thinking === "string") {
      const res = truncateHistoryText(entry.thinking);
      entry.thinking = res.text;
      truncated ||= res.truncated;
      redacted ||= res.redacted;
    }
    // The encrypted signature can be extremely large and is not useful for history recall.
    if ("thinkingSignature" in entry) {
      delete entry.thinkingSignature;
      truncated = true;
    }
    if ("openclawReasoningReplay" in entry) {
      delete entry.openclawReasoningReplay;
      truncated = true;
    }
  }
  if (typeof entry.partialJson === "string") {
    const res = truncateHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (type === "image") {
    const data = readStringValue(entry.data);
    const bytes = data ? data.length : undefined;
    if ("data" in entry) {
      delete entry.data;
      truncated = true;
    }
    entry.omitted = true;
    if (bytes !== undefined) {
      entry.bytes = bytes;
    }
  }
  return { block: entry, truncated, redacted };
}

function sanitizeHistoryMessage(message: unknown): {
  message: unknown;
  truncated: boolean;
  redacted: boolean;
} {
  if (!message || typeof message !== "object") {
    return { message, truncated: false, redacted: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let truncated = false;
  let redacted = false;
  // Tool result details often contain very large nested payloads.
  if ("details" in entry) {
    delete entry.details;
    truncated = true;
  }
  if ("usage" in entry) {
    delete entry.usage;
    truncated = true;
  }
  if ("cost" in entry) {
    delete entry.cost;
    truncated = true;
  }

  if (typeof entry.content === "string") {
    const res = truncateHistoryText(entry.content);
    entry.content = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => sanitizeHistoryContentBlock(block));
    entry.content = updated.map((item) => item.block);
    truncated ||= updated.some((item) => item.truncated);
    redacted ||= updated.some((item) => item.redacted);
  }
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  return { message: entry, truncated, redacted };
}

function readHistoryMessageRole(message: Record<string, unknown>): string {
  return typeof message.role === "string" ? message.role.toLowerCase() : "";
}

function truncateToolHistoryText(
  text: string,
  maxChars: number = SESSIONS_HISTORY_TOOL_TEXT_MAX_CHARS,
): {
  text: string;
  truncated: boolean;
  redacted: boolean;
} {
  const sanitized = redactToolPayloadText(text);
  const redacted = sanitized !== text;
  if (sanitized.length <= maxChars) {
    return { text: sanitized, truncated: false, redacted };
  }
  const cut = truncateUtf16Safe(sanitized, maxChars);
  return { text: `${cut}\n…(tool result summarized)…`, truncated: true, redacted };
}

function summarizeToolHistoryContentBlock(
  block: unknown,
  params: { toolResultMaxChars: number },
): {
  block: unknown;
  truncated: boolean;
  redacted: boolean;
} {
  if (!block || typeof block !== "object") {
    return { block, truncated: false, redacted: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let truncated = false;
  let redacted = false;
  if (typeof entry.text === "string") {
    const res = truncateToolHistoryText(entry.text, params.toolResultMaxChars);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (typeof entry.content === "string") {
    const res = truncateToolHistoryText(entry.content, params.toolResultMaxChars);
    entry.content = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  return { block: entry, truncated, redacted };
}

function summarizeToolHistoryMessage(
  message: unknown,
  params: { toolResultMaxChars: number },
): {
  message: unknown;
  truncated: boolean;
  redacted: boolean;
} {
  if (!message || typeof message !== "object") {
    return { message, truncated: false, redacted: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  if (readHistoryMessageRole(entry) !== "toolresult") {
    return sanitizeHistoryMessage(entry);
  }

  let truncated = false;
  let redacted = false;
  if ("details" in entry) {
    delete entry.details;
    truncated = true;
  }
  if ("usage" in entry) {
    delete entry.usage;
    truncated = true;
  }
  if ("cost" in entry) {
    delete entry.cost;
    truncated = true;
  }

  const originalChars =
    (typeof entry.content === "string" ? entry.content.length : 0) +
    (typeof entry.text === "string" ? entry.text.length : 0);
  if (typeof entry.content === "string") {
    const res = truncateToolHistoryText(entry.content, params.toolResultMaxChars);
    entry.content = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => summarizeToolHistoryContentBlock(block, params));
    entry.content = updated.map((item) => item.block);
    truncated ||= updated.some((item) => item.truncated);
    redacted ||= updated.some((item) => item.redacted);
  }
  if (typeof entry.text === "string") {
    const res = truncateToolHistoryText(entry.text, params.toolResultMaxChars);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (truncated) {
    entry.toolResultSummary = {
      summarized: true,
      originalChars,
      retainedMaxChars: params.toolResultMaxChars,
    };
  }
  return { message: entry, truncated, redacted };
}

function enforceSessionsHistoryHardCap(params: {
  items: unknown[];
  bytes: number;
  maxBytes: number;
}): { items: unknown[]; bytes: number; hardCapped: boolean } {
  if (params.bytes <= params.maxBytes) {
    return { items: params.items, bytes: params.bytes, hardCapped: false };
  }

  const last = params.items.at(-1);
  const lastOnly = last ? [last] : [];
  const lastBytes = jsonUtf8Bytes(lastOnly);
  if (lastBytes <= params.maxBytes) {
    return { items: lastOnly, bytes: lastBytes, hardCapped: true };
  }

  const placeholder = [
    {
      role: "assistant",
      content: "[sessions_history omitted: message too large]",
    },
  ];
  return { items: placeholder, bytes: jsonUtf8Bytes(placeholder), hardCapped: true };
}

export function createSessionsHistoryTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session History",
    name: "sessions_history",
    displaySummary: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsHistoryTool(),
    parameters: SessionsHistoryToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callGateway;
      const sessionKeyParam = readStringParam(params, "sessionKey", {
        required: true,
      });
      const cfg = opts?.config ?? getRuntimeConfig();
      const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      const resolvedSession = await resolveSessionReference({
        sessionKey: sessionKeyParam,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({ status: resolvedSession.status, error: resolvedSession.error });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKeyParam,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          status: visibleSession.status,
          error: visibleSession.error,
        });
      }
      // From here on, use the canonical key (sessionId inputs already resolved).
      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: effectiveRequesterKey,
        visibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          status: access.status,
          error: access.error,
        });
      }

      const limit = readPositiveIntegerParam(params, "limit");
      const includeTools = Boolean(params.includeTools);
      const historyLimits = resolveSessionsHistoryLimits(cfg);
      const result = await gatewayCall<{ messages: Array<unknown> }>({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit },
      });
      const rawMessages = Array.isArray(result?.messages) ? result.messages : [];
      const selectedMessages = includeTools ? rawMessages : stripToolMessages(rawMessages);
      const sanitizedMessages = selectedMessages.map((message) =>
        includeTools
          ? summarizeToolHistoryMessage(message, {
              toolResultMaxChars: historyLimits.toolResultMaxChars,
            })
          : sanitizeHistoryMessage(message),
      );
      const contentTruncated = sanitizedMessages.some((entry) => entry.truncated);
      const contentRedacted = sanitizedMessages.some((entry) => entry.redacted);
      const maxBytes = includeTools
        ? historyLimits.includeToolsMaxBytes
        : SESSIONS_HISTORY_MAX_BYTES;
      const cappedMessages = capArrayByJsonBytes(
        sanitizedMessages.map((entry) => entry.message),
        maxBytes,
      );
      const droppedMessages = cappedMessages.items.length < selectedMessages.length;
      const hardened = enforceSessionsHistoryHardCap({
        items: cappedMessages.items,
        bytes: cappedMessages.bytes,
        maxBytes,
      });
      return jsonResult({
        sessionKey: displayKey,
        messages: hardened.items,
        truncated: droppedMessages || contentTruncated || hardened.hardCapped,
        droppedMessages: droppedMessages || hardened.hardCapped,
        contentTruncated,
        contentRedacted,
        bytes: hardened.bytes,
      });
    },
  };
}

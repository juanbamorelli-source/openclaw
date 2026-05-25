import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { type ReplyExecOverrides, resolveReplyExecOverrides } from "./get-reply-exec-overrides.js";

const AGENT_EXEC_DEFAULTS = {
  host: "node",
  mode: "ask",
  security: "allowlist",
  ask: "always",
  node: "worker-alpha",
} as const satisfies ReplyExecOverrides;
const AGENT_MODE_DEFAULTS = {
  host: "node",
  mode: "ask",
  security: undefined,
  ask: undefined,
  node: "worker-alpha",
} as const satisfies ReplyExecOverrides;
const GLOBAL_EXEC_DEFAULTS = {
  host: "gateway",
  mode: "deny",
} as const satisfies ReplyExecOverrides;

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "main",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("reply exec overrides", () => {
  it("uses global exec defaults when narrower scopes are unset", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry(),
        globalExecDefaults: GLOBAL_EXEC_DEFAULTS,
      }),
    ).toEqual({
      host: "gateway",
      mode: "deny",
      security: undefined,
      ask: undefined,
      node: undefined,
    });
  });

  it("lets agent, session, and inline exec settings override global defaults", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec host=node ask=always"),
        sessionEntry: createSessionEntry({
          execSecurity: "allowlist",
        }),
        globalExecDefaults: GLOBAL_EXEC_DEFAULTS,
        agentExecDefaults: {
          node: "worker-alpha",
          security: "full",
        },
      }),
    ).toEqual({
      host: "node",
      mode: undefined,
      security: "allowlist",
      ask: "always",
      node: "worker-alpha",
    });
  });

  it("uses per-agent exec defaults when session and message are unset", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry(),
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual(AGENT_MODE_DEFAULTS);
  });

  it("prefers inline exec directives, then persisted session overrides, then agent defaults", () => {
    const sessionEntry = createSessionEntry({
      execHost: "gateway",
      execMode: "auto",
      execSecurity: "deny",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec host=auto mode=full"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      host: "auto",
      mode: "full",
      security: undefined,
      ask: undefined,
      node: "worker-alpha",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      host: "gateway",
      mode: "auto",
      security: undefined,
      ask: undefined,
      node: "worker-alpha",
    });
  });

  it("uses persisted session exec fields for later turns", () => {
    const sessionEntry = createSessionEntry({
      execHost: "gateway",
      execSecurity: "full",
      execAsk: "always",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      host: "gateway",
      mode: undefined,
      security: "full",
      ask: "always",
      node: "worker-alpha",
    });
  });

  it("ignores stale persisted session exec modes that are no longer valid", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry({
          execMode: "bogus",
        }),
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      host: "node",
      mode: "ask",
      security: undefined,
      ask: undefined,
      node: "worker-alpha",
    });
  });

  it("does not carry lower-scope mode through a narrower legacy policy override", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec security=deny"),
        sessionEntry: createSessionEntry({
          execMode: "auto",
        }),
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toMatchObject({
      mode: undefined,
      security: "deny",
      ask: "on-miss",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry({
          execAsk: "always",
        }),
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toMatchObject({
      mode: undefined,
      security: "allowlist",
      ask: "always",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry({
          execSecurity: "full",
        }),
        agentExecDefaults: {
          ...AGENT_EXEC_DEFAULTS,
          mode: "auto",
          security: undefined,
          ask: undefined,
        },
      }),
    ).toMatchObject({
      mode: undefined,
      security: "full",
      ask: "on-miss",
    });
  });

  it("ignores stale legacy policy fields when a mode is present", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec ask=off"),
        sessionEntry: createSessionEntry(),
        globalExecDefaults: {
          mode: "auto",
          security: "full",
        },
      }),
    ).toMatchObject({
      mode: undefined,
      security: "allowlist",
      ask: "off",
    });
  });

  it("materializes mode policy before applying partial inline legacy overrides", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec ask=off"),
        sessionEntry: createSessionEntry({
          execMode: "auto",
        }),
        agentExecDefaults: undefined,
      }),
    ).toMatchObject({
      mode: undefined,
      security: "allowlist",
      ask: "off",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec security=full"),
        sessionEntry: createSessionEntry({
          execMode: "auto",
        }),
        agentExecDefaults: undefined,
      }),
    ).toMatchObject({
      mode: undefined,
      security: "full",
      ask: "on-miss",
    });
  });

  it("ignores mixed inline exec mode and legacy policy fields", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec mode=full security=deny ask=always"),
        sessionEntry: createSessionEntry({
          execSecurity: "deny",
          execAsk: "off",
        }),
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      host: "node",
      mode: undefined,
      security: "deny",
      ask: "off",
      node: "worker-alpha",
    });
  });

  it("ignores inline exec options when any exec option is invalid", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec host=other mode=full"),
        sessionEntry: createSessionEntry({
          execHost: "gateway",
          execSecurity: "deny",
          execAsk: "off",
        }),
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      host: "gateway",
      mode: undefined,
      security: "deny",
      ask: "off",
      node: "worker-alpha",
    });
  });
});

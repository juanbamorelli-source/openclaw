import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectConfiguredAgentHarnessRuntimes } from "./harness-runtimes.js";

describe("collectConfiguredAgentHarnessRuntimes", () => {
  it("includes Codex for selectable OpenAI default models when primary is not OpenAI", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
          },
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/gpt-5.5": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config, {}, { includeEnvRuntime: false })).toEqual(
      ["codex"],
    );
  });

  it("does not include Codex for selectable OpenAI models pinned to PI", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
          },
          models: {
            "openai/gpt-5.5": {
              agentRuntime: { id: "pi" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config, {}, { includeEnvRuntime: false })).toEqual(
      [],
    );
  });

  it("includes Codex for selectable per-agent OpenAI models", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
          },
        },
        list: [
          {
            id: "ops",
            models: {
              "openai/gpt-5.5": {},
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config, {}, { includeEnvRuntime: false })).toEqual(
      ["codex"],
    );
  });

  it("ignores malformed agents.list while scanning best-effort config", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {
              agentRuntime: { id: "claude" },
            },
          },
        },
        list: {
          ops: {
            id: "ops",
            agentRuntime: { id: "codex" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config, {}, { includeEnvRuntime: false })).toEqual(
      ["claude"],
    );
  });
});

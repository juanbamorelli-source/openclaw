// Regression tests for non-fatal prompt and compaction hook failure handling.
import { afterEach, describe, expect, it, vi } from "vitest";

const hookRunnerMocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hookRunnerMocks.getGlobalHookRunner,
}));

import {
  resolveAgentHarnessBeforePromptBuildResult,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
} from "./prompt-compaction-hook-helpers.js";

function createHostileThrownValue(): unknown {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("property trap");
      },
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
      ownKeys() {
        throw new Error("ownKeys trap");
      },
    },
  );
}

const CTX = {
  runId: "run-1",
  sessionKey: "agent:main:session-1",
};

describe("agent harness prompt and compaction hook helpers", () => {
  afterEach(() => {
    hookRunnerMocks.getGlobalHookRunner.mockReset();
  });

  it("preserves prompt fields when prompt hooks throw hostile values", async () => {
    hookRunnerMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn(
        (hookName: string) =>
          hookName === "before_prompt_build" || hookName === "before_agent_start",
      ),
      runBeforePromptBuild: vi.fn(async () => {
        throw createHostileThrownValue();
      }),
      runBeforeAgentStart: vi.fn(async () => {
        throw createHostileThrownValue();
      }),
    });

    await expect(
      resolveAgentHarnessBeforePromptBuildResult({
        prompt: "base prompt",
        developerInstructions: "base instructions",
        messages: [],
        ctx: CTX,
      }),
    ).resolves.toEqual({
      prompt: "base prompt",
      developerInstructions: "base instructions",
    });
  });

  it("keeps hostile compaction hook failures non-fatal", async () => {
    hookRunnerMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn(
        (hookName: string) => hookName === "before_compaction" || hookName === "after_compaction",
      ),
      runBeforeCompaction: vi.fn(async () => {
        throw createHostileThrownValue();
      }),
      runAfterCompaction: vi.fn(async () => {
        throw createHostileThrownValue();
      }),
    });

    await expect(
      runAgentHarnessBeforeCompactionHook({
        sessionFile: "session.jsonl",
        messages: [],
        ctx: CTX,
      }),
    ).resolves.toBeUndefined();
    await expect(
      runAgentHarnessAfterCompactionHook({
        sessionFile: "session.jsonl",
        messages: [],
        compactedCount: 0,
        ctx: CTX,
      }),
    ).resolves.toBeUndefined();
  });
});

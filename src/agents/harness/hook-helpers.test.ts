// Regression tests for non-fatal agent harness tool hook failure handling.
import { afterEach, describe, expect, it, vi } from "vitest";

const hookRunnerMocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hookRunnerMocks.getGlobalHookRunner,
}));

import { runAgentHarnessAfterToolCallHook } from "./hook-helpers.js";

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

describe("agent harness hook helpers", () => {
  afterEach(() => {
    hookRunnerMocks.getGlobalHookRunner.mockReset();
  });

  it("keeps hostile after_tool_call hook failures non-fatal", async () => {
    const runAfterToolCall = vi.fn(async () => {
      throw createHostileThrownValue();
    });
    hookRunnerMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => hookName === "after_tool_call"),
      runAfterToolCall,
    });

    await expect(
      runAgentHarnessAfterToolCallHook({
        toolName: "demo",
        toolCallId: "call-1",
        runId: "run-1",
        sessionKey: "agent:main:session-1",
        startArgs: {},
      }),
    ).resolves.toBeUndefined();

    expect(runAfterToolCall).toHaveBeenCalledTimes(1);
  });
});

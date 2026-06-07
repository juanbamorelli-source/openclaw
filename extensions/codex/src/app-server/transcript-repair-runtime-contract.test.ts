// Codex tests cover transcript repair runtime contract plugin behavior.
import {
  assistantHistoryMessage,
  currentPromptHistoryMessage,
  mediaOnlyHistoryMessage,
  structuredHistoryMessage,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it } from "vitest";
import { projectContextEngineAssemblyForCodex } from "./context-engine-projection.js";

describe("Codex transcript projection runtime contract", () => {
  it("drops only the duplicate trailing current prompt while preserving prior structured context", () => {
    const prompt = "newest inbound message";

    const result = projectContextEngineAssemblyForCodex({
      prompt,
      originalHistoryMessages: [structuredHistoryMessage()],
      assembledMessages: [
        structuredHistoryMessage(),
        assistantHistoryMessage(),
        currentPromptHistoryMessage(prompt),
      ],
    });

    expect(result.promptText).toContain("Current user request:\nnewest inbound message");
    expect(result.promptText).toContain("[user]\nolder structured context\n[image omitted]");
    expect(result.promptText).toContain("[assistant]\nack");
    expect(result.promptText).not.toContain("[user]\nnewest inbound message");
  });

  it("treats repeated historical user instructions as quoted context, not the latest ask", () => {
    const oldInstruction = "go ahead: I would not one-shot all five specs. That's how we got here.";
    const latestAsk = "you have a worktree, what are we working on?";

    const result = projectContextEngineAssemblyForCodex({
      prompt: latestAsk,
      originalHistoryMessages: [currentPromptHistoryMessage(oldInstruction)],
      assembledMessages: [
        currentPromptHistoryMessage(oldInstruction),
        assistantHistoryMessage(),
        currentPromptHistoryMessage(oldInstruction),
      ],
    });

    expect(result.promptText).toContain("quoted reference data");
    expect(result.promptText).toContain(`[user]\n${oldInstruction}`);
    expect(result.promptText).toContain(`Current user request:\n${latestAsk}`);
    expect(result.promptText.split("Current user request:\n").at(-1)).toBe(latestAsk);
  });

  it("keeps media-only user history visible as omitted media instead of dropping the turn", () => {
    const result = projectContextEngineAssemblyForCodex({
      prompt: "newest inbound message",
      originalHistoryMessages: [mediaOnlyHistoryMessage()],
      assembledMessages: [
        mediaOnlyHistoryMessage(),
        currentPromptHistoryMessage("newest inbound message"),
      ],
    });

    expect(result.promptText).toContain("[user]\n[image omitted]");
    expect(result.promptText).not.toContain("data:image/png");
    expect(result.promptText).not.toContain("bbbb");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillCommandSpec } from "../../skills/types.js";
import type { SkillProposalManifestEntry } from "../../skills/workshop/types.js";
import { handleSkillWorkshopCommand } from "./commands-skill-workshop.js";
import { buildCommandTestParams, baseCommandTestConfig } from "./commands.test-harness.js";

const applySkillProposalMock = vi.hoisted(() => vi.fn());
const listSkillProposalsMock = vi.hoisted(() => vi.fn());
const quarantineSkillProposalMock = vi.hoisted(() => vi.fn());
const rejectSkillProposalMock = vi.hoisted(() => vi.fn());

vi.mock("../../skills/workshop/service.js", () => ({
  applySkillProposal: applySkillProposalMock,
  listSkillProposals: listSkillProposalsMock,
  quarantineSkillProposal: quarantineSkillProposalMock,
  rejectSkillProposal: rejectSkillProposalMock,
}));

function ownerParams(commandBody: string) {
  const params = buildCommandTestParams(commandBody, baseCommandTestConfig, undefined, {
    workspaceDir: "/tmp/workshop-owner-command",
  });
  params.command.senderIsOwner = true;
  params.command.senderId = "owner";
  return params;
}

const proposal: SkillProposalManifestEntry = {
  id: "weather-helper-20260801-abc123def4",
  kind: "create",
  status: "pending",
  title: "Create Weather Helper",
  description: "Weather workflow",
  skillName: "Weather Helper",
  skillKey: "weather-helper",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  scanState: "clean",
};

beforeEach(() => {
  applySkillProposalMock.mockReset();
  listSkillProposalsMock.mockReset();
  quarantineSkillProposalMock.mockReset();
  rejectSkillProposalMock.mockReset();
});

describe("handleSkillWorkshopCommand", () => {
  it("runs an owner's exact apply command without a model or plugin approval handoff", async () => {
    applySkillProposalMock.mockResolvedValue({
      record: {
        ...proposal,
        target: { skillKey: proposal.skillKey },
      },
    });

    await expect(
      handleSkillWorkshopCommand(ownerParams(`/skill apply ${proposal.id}`), true),
    ).resolves.toEqual({
      shouldContinue: false,
      reply: { text: `✅ Applied ${proposal.id} to weather-helper.` },
    });
    expect(applySkillProposalMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workshop-owner-command",
      config: baseCommandTestConfig,
      proposalId: proposal.id,
    });
    expect(rejectSkillProposalMock).not.toHaveBeenCalled();
    expect(quarantineSkillProposalMock).not.toHaveBeenCalled();
  });

  it("preserves an existing user-invocable skill command named apply", async () => {
    const params = ownerParams(`/skill apply ${proposal.id}`);
    params.skillCommands = [
      {
        name: "apply",
        skillName: "apply",
        description: "Existing user skill",
      } satisfies SkillCommandSpec,
    ];

    await expect(handleSkillWorkshopCommand(params, true)).resolves.toBeNull();
    expect(applySkillProposalMock).not.toHaveBeenCalled();
  });

  it("leaves ordinary owner skill commands on the existing skill path", async () => {
    const params = ownerParams("/skill weather-helper forecast");
    params.skillCommands = [
      {
        name: "weather-helper",
        skillName: "weather-helper",
        description: "Existing user skill",
      } satisfies SkillCommandSpec,
    ];

    await expect(handleSkillWorkshopCommand(params, true)).resolves.toBeNull();
    expect(listSkillProposalsMock).not.toHaveBeenCalled();
  });

  it("passes a reject reason only to the exact proposal selected by the owner", async () => {
    rejectSkillProposalMock.mockResolvedValue({
      ...proposal,
      target: { skillKey: proposal.skillKey },
    });

    await expect(
      handleSkillWorkshopCommand(
        ownerParams(`/skill reject ${proposal.id} no longer needed`),
        true,
      ),
    ).resolves.toEqual({
      shouldContinue: false,
      reply: { text: `✅ Rejected ${proposal.id} (weather-helper).` },
    });
    expect(rejectSkillProposalMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workshop-owner-command",
      config: baseCommandTestConfig,
      proposalId: proposal.id,
      reason: "no longer needed",
    });
    expect(applySkillProposalMock).not.toHaveBeenCalled();
  });

  it("lists only matching proposals without falling through to an agent turn", async () => {
    listSkillProposalsMock.mockResolvedValue({
      proposals: [
        proposal,
        {
          ...proposal,
          id: "other-20260801-abcdef1234",
          skillKey: "other",
          title: "Create Other",
          description: "Other workflow",
        },
      ],
    });

    await expect(
      handleSkillWorkshopCommand(ownerParams("/skill list weather"), true),
    ).resolves.toEqual({
      shouldContinue: false,
      reply: {
        text: `Skill Workshop proposals:\n• ${proposal.id} — pending — weather-helper`,
      },
    });
    expect(listSkillProposalsMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workshop-owner-command",
    });
  });

  it("stops an unauthorized lifecycle-looking message before a model can reinterpret it", async () => {
    const params = ownerParams(`/skill apply ${proposal.id}`);
    params.command.senderIsOwner = false;

    await expect(handleSkillWorkshopCommand(params, true)).resolves.toEqual({
      shouldContinue: false,
    });
    expect(applySkillProposalMock).not.toHaveBeenCalled();
  });

  it("requires normal command authorization before any owner lifecycle action", async () => {
    const params = ownerParams(`/skill apply ${proposal.id}`);
    params.command.isAuthorizedSender = false;

    await expect(handleSkillWorkshopCommand(params, true)).resolves.toEqual({
      shouldContinue: false,
    });
    expect(applySkillProposalMock).not.toHaveBeenCalled();
  });

  it("leaves unrelated text to the normal command/agent path", async () => {
    await expect(
      handleSkillWorkshopCommand(ownerParams("please apply it"), true),
    ).resolves.toBeNull();
  });
});
